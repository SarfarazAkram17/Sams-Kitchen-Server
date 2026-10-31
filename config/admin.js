import "dotenv/config";

// Inbox that receives admin notifications and pickup verification codes.
const ADMIN_EMAIL = process.env.OTP_ADMIN_EMAIL || "sarfarazakram16@gmail.com";

export { ADMIN_EMAIL };
