const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const sql = require("mssql");
const nodemailer = require("nodemailer");

// แปลงวันที่เป็นรูปแบบไทย: "19 ธ.ค. 68" (พ.ศ. +543 และเอา 2 หลักท้าย)
// รองรับ input แบบ 'YYYY-MM-DD' โดยกันปัญหา timezone เลื่อนวัน
function thaiDateFullMonth(dateInput) {
  if (!dateInput) return "";

  let d;
  if (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    // บังคับเป็น local time 00:00:00 กันเลื่อนวันจาก timezone
    d = new Date(`${dateInput}T00:00:00`);
  } else {
    d = new Date(dateInput);
  }
  if (Number.isNaN(d.getTime())) return "";

  const monthTHbrev = [
    null, "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
  ];

  const day = d.getDate();
  const month = monthTHbrev[d.getMonth() + 1];
  const buddhistYear2 = String(d.getFullYear() + 543).slice(-2);

  return `${day} ${month} ${buddhistYear2}`;
}

// ทำ subject ให้ตรงกับประเภทแจ้งเตือน
function buildSubject(alertType) {
  // 1=6เดือน, 2=3เดือน, 3=หมดอายุวันนี้/Day0 (ตาม logic เดิมใน SQL)
  if (String(alertType) === "3") return "⏰ ใบอนุญาตหมดอายุแล้ว (ด่วน)";
  if (String(alertType) === "2") return "⚠️ แจ้งเตือนครั้งที่ 2: ใบอนุญาตใกล้หมดอายุ";
  if (String(alertType) === "1") return "⚠️ แจ้งเตือนครั้งที่ 1: ใบอนุญาตใกล้หมดอายุ";
  return "แจ้งเตือนใบอนุญาต";
}

async function main() {
  // 1) SQL Server config
  const dbConfig = {
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    options: {
      encrypt: false,
      trustServerCertificate: true
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
  };

  // 2) Mail transporter
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false, // 587 ใช้ STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    requireTLS: true,
    tls: {
      // ถ้าเจอปัญหา cert แปลก ๆ ในระบบ intranet ค่อยเปิดบรรทัดล่าง
      // rejectUnauthorized: false
    }
  });

  // 3) Query
  const query = `
    SELECT  p.*,
        CASE 
            WHEN p.ExpiryDate = CONVERT(date, GETDATE()) THEN '3'
            WHEN p.ExpiryDate = DATEADD(MONTH, 3, CONVERT(date, GETDATE())) THEN '2'
            WHEN p.ExpiryDate = DATEADD(MONTH, 6, CONVERT(date, GETDATE())) THEN '1'
        END AS AlertType,
        CASE
            WHEN p.ExpiryDate = CONVERT(date, GETDATE())
                THEN N'Day 0 ⏰ ใบอนุญาตของคุณหมดอายุแล้ว กรุณาแสดงใบอนุญาตที่ต่ออายุแล้วกับ HRM NSO'
            WHEN p.ExpiryDate = DATEADD(MONTH, 3, CONVERT(date, GETDATE()))
                THEN N'⚠️แจ้งเตือนครั้งที่ 2 ใบอนุญาตของคุณกำลังจะหมดอายุ ในวันที่'
            WHEN p.ExpiryDate = DATEADD(MONTH, 6, CONVERT(date, GETDATE()))
                THEN N'⚠️แจ้งเตือนครั้งที่ 1 ใบอนุญาตของคุณกำลังจะหมดอายุ ในวันที่'
        END AS AlertMessage,
        CONVERT(varchar(10), p.ExpiryDate, 23) AS Expiry
FROM Saraburi.dbo.ProfessionalLicense p
WHERE p.Deleted = '0'
  AND (
        ( p.ExpiryDate = DATEADD(MONTH, 6, CONVERT(date, GETDATE())) AND p.SendEmail IS NULL)
        OR
        ( p.ExpiryDate = DATEADD(MONTH, 3, CONVERT(date, GETDATE())) AND p.SendEmail = '1')
        OR
        ( p.ExpiryDate = CONVERT(date, GETDATE()) AND p.SendEmail = '2')
      );
  `;

  let pool;
  try {
    pool = await sql.connect(dbConfig);

    const result = await pool.request().query(query);
    const rows = result.recordset || [];

    if (rows.length === 0) {
      console.log("ไม่พบรายการที่ต้องส่งแจ้งเตือน");
      return;
    }

    console.log(`พบ ${rows.length} รายการที่ต้องส่งแจ้งเตือน`);

    for (const row of rows) {
      const emails = (row.Emails || "").trim();
      const alertMessage = row.AlertMessage || "";
      const expiryThai = thaiDateFullMonth(row.Expiry);
      const alertType = String(row.AlertType || "");
      const licenseNo = String(row.LicenseNo || "");

      if (!emails) {
        console.log(`ข้าม: LicenseNo=${licenseNo} ไม่มี Emails`);
        continue;
      }

      const subject = buildSubject(alertType);

      // HTML ให้ดูเป็นเมลทางการ + ขึ้นบรรทัดใหม่ชัดเจน
      const html = `
        <div style="font-family: Tahoma, Arial, sans-serif; font-size: 14px; line-height: 1.7;">
          <p>${alertMessage} <b>${expiryThai}</b></p>
          <p><b>เลขที่ใบอนุญาต:</b> ${licenseNo}</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:12px 0;" />
          <p style="color:#666;">หมายเหตุ: กรุณาดำเนินการต่ออายุและนำหลักฐานมาแสดงกับ HRM NSO</p>
        </div>
      `;

      const text = `${alertMessage} ${expiryThai}\nเลขที่ใบอนุญาต: ${licenseNo}\n\nหมายเหตุ: กรุณาดำเนินการต่ออายุและนำหลักฐานมาแสดงกับ HRM NSO`;

      try {
        await transporter.sendMail({
          from: {
            name: "กลุ่มการพยาบาล",
            address: process.env.SMTP_USER
          },
          to: emails,
          subject,
          html,
          text
        });

        console.log(`ส่งเมลสำเร็จ: ${emails} (LicenseNo=${licenseNo})`);

        // อัปเดต SendEmail (เก็บสถานะแจ้งเตือนล่าสุด)
        await pool.request()
          .input("alertType", sql.VarChar(10), alertType)
          .input("licenseNo", sql.VarChar(50), licenseNo)
          .query(`
            UPDATE Saraburi.dbo.ProfessionalLicense
            SET SendEmail = @alertType
            WHERE LicenseNo = @licenseNo;
          `);

      } catch (mailErr) {
        console.error(
          `ส่งเมลไม่สำเร็จ: ${emails} (LicenseNo=${licenseNo})`,
          mailErr?.message || mailErr
        );
      }
    }
  } catch (err) {
    console.error("เกิดข้อผิดพลาด:", err?.message || err);
  } finally {
    try { await sql.close(); } catch {}
  }
}

main();
