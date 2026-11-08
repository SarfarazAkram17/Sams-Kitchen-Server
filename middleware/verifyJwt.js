import jwt from "jsonwebtoken";
import { client, DB_NAME } from "../config/db.js";

// Checks the cookie, then reads the account's role from the database on every
// request, so a role change (approval, promotion) takes effect immediately and
// nothing about permissions is trusted from the token.
const verifyJwt = (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "Forbidden: Invalid token" });
    }

    if (req.query.email !== decoded.email) {
      return res.status(403).send({ message: "Forbidden: Email mismatch" });
    }

    try {
      const user = await client
        .db(DB_NAME)
        .collection("usersCollection")
        .findOne({ email: decoded.email }, { projection: { role: 1 } });

      if (!user) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }

      req.user = { email: decoded.email, role: user.role || null };
      next();
    } catch (error) {
      res.status(500).send({ message: "Failed to verify account" });
    }
  });
};

export default verifyJwt;
