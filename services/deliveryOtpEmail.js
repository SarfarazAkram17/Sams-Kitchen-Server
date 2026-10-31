import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASS,
  },
});

const sendMail = async (to, subject, html) => {
  if (!process.env.EMAIL || !process.env.PASS) {
    const error = new Error("EMAIL_NOT_CONFIGURED");
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }

  try {
    await transporter.sendMail({
      from: `"Sam's Kitchen" <${process.env.EMAIL}>`,
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error(
      "Failed to send a delivery verification email.",
      error?.code || "UNKNOWN",
    );
    const sendError = new Error("OTP_EMAIL_SEND_FAILED");
    sendError.code = error?.code || "OTP_EMAIL_SEND_FAILED";
    throw sendError;
  }
};

const sendDeliveryOtpEmail = async ({ to, code, status, orderId }) => {
  const action =
    status === "picked" ? "confirm order pickup" : "confirm delivery";
  const html = `<p>Your Sam's Kitchen verification code to ${action} is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 5 minutes and can only be used once.</p><p>Order: ${orderId}</p><p>If you did not expect this message, you can ignore it.</p>`;

  await sendMail(to, `Sam's Kitchen verification code to ${action}`, html);
};

export { sendDeliveryOtpEmail };