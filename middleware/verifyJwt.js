const jwt = require("jsonwebtoken");

const verifyJwt = (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "Forbidden: Invalid token" });
    }

    if (req.query.email !== decoded.email) {
      return res.status(403).send({ message: "Forbidden: Email mismatch" });
    }
    req.user = decoded;
    next();
  });
};

module.exports = verifyJwt;