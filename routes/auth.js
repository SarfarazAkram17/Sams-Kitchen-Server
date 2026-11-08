import express from "express";
import jwt from "jsonwebtoken";

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
});

export default (usersCollection) => {
  const router = express.Router();

  router.post("/jwt", async (req, res) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email : "";
      const user = email
        ? await usersCollection.findOne({ email }, { projection: { email: 1 } })
        : null;

      // New sign-ins have no account yet; the client creates it, then asks again.
      if (!user) {
        return res.status(404).send({ message: "Account not found" });
      }

      await usersCollection.updateOne(
        { email: user.email },
        { $set: { last_log_in: Date.now().toString() } },
      );

      // The role is looked up in the database on every request, so the token
      // only identifies the account.
      const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });

      res.cookie("token", token, {
        ...cookieOptions(),
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.send({ success: true });
    } catch (error) {
      res.status(500).send({ message: "Failed to start your session" });
    }
  });

  router.post("/logout", (req, res) => {
    res.clearCookie("token", cookieOptions());
    res.send({ success: true });
  });

  return router;
};
