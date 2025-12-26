require("dotenv").config();
const nodemailer = require("nodemailer");

(async () => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"ทดสอบ" <${process.env.SMTP_USER}>`,
    to: "yourmail@gmail.com",
    subject: "ทดสอบจาก Node.js บน Server",
    text: "ถ้าเมลนี้ถึง แสดงว่า network ผ่าน"
  });

  console.log("ส่งเมลสำเร็จ");
})();