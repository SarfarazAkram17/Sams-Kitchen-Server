const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

module.exports = (usersCollection) => {
  router.post("/jwt", async (req, res) => {
    const { email } = req.body;
    const user = await usersCollection.findOne({ email });

    const payload = { email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.send({ success: true, token });
  });

  router.post("/logout", (req, res) => {
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });
    res.send({ success: true });
  });

  return router;
};