require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
const upload = multer({ dest: 'uploads/' });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());

// Cho phép load trang web trực tiếp từ file index.html ở thư mục gốc
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Cấu hình Gmail Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

// Đọc text từ file PDF / DOCX
async function extractText(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        return data.text;
    } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
    }
    throw new Error(`Định dạng không hỗ trợ: ${originalName}`);
}

// Khởi tạo Google Sheets Auth bằng Biến môi trường (Thay thế file credentials.json)
function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            // Xử lý xuống dòng cho private key khi đưa vào biến môi trường
            private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
}

// API 1: Phân tích CV bằng Gemini AI
app.post('/api/analyze', upload.array('cvs'), async (req, res) => {
    const jdText = req.body.jd;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'Vui lòng tải lên ít nhất 1 file CV.' });
    }

    const results = [];

    for (const file of files) {
        try {
            const cvText = await extractText(file.path, file.originalname);
            const prompt = `
        Bạn là chuyên gia tuyển dụng (HR). Hãy đánh giá CV sau dựa trên Mô tả công việc (JD).
        Chấm điểm từ 0-100. Từ 70 điểm trở lên là đạt (isQualified = true).
        
        --- JD ---
        ${jdText}
        
        --- CV ---
        ${cvText}
      `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            fullName: { type: Type.STRING },
                            email: { type: Type.STRING },
                            phone: { type: Type.STRING },
                            score: { type: Type.INTEGER },
                            isQualified: { type: Type.BOOLEAN },
                            summary: { type: Type.STRING },
                        },
                        required: ['fullName', 'email', 'phone', 'score', 'isQualified', 'summary'],
                    },
                },
            });

            const parsed = JSON.parse(response.text);
            results.push({ fileName: file.originalname, ...parsed });
        } catch (err) {
            results.push({ fileName: file.originalname, error: err.message });
        } finally {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    }

    res.json({ results });
});

// API 2: Gửi Email từ chối
app.post('/api/reject', async (req, res) => {
    const { fullName, email } = req.body;
    try {
        if (!email || !email.includes('@')) throw new Error('Email không hợp lệ');

        await transporter.sendMail({
            from: `"Phòng Tuyển Dụng" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: 'Thông báo kết quả ứng tuyển',
            html: `
        <p>Chào <b>${fullName}</b>,</p>
        <p>Cảm ơn bạn đã quan tâm và gửi hồ sơ ứng tuyển vào vị trí của chúng tôi.</p>
        <p>Sau khi xem xét kỹ lưỡng, chúng tôi nhận thấy hồ sơ của bạn hiện chưa phù hợp với các tiêu chí của vị trí này ở thời điểm hiện tại. Chúng tôi xin phép lưu lại hồ sơ cho những cơ hội phù hợp hơn trong tương lai.</p>
        <p>Chúc bạn nhiều sức khỏe và thành công!</p>
        <p>Trân trọng,<br>Bộ phận Tuyển dụng.</p>
      `,
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API 3: Thêm vào Google Sheets
app.post('/api/approve', async (req, res) => {
    const { fullName, email, phone, score, summary, fileName } = req.body;
    try {
        const sheets = getSheetsClient();
        const values = [[
            new Date().toLocaleDateString('vi-VN'),
            fullName,
            email,
            phone,
            score,
            summary,
            fileName
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Sheet1!A:G',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy trên cổng ${PORT}`));