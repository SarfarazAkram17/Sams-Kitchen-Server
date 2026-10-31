import { client, DB_NAME } from "../config/db.js";

// The role is read from the database, not the JWT, so a customer who was just
// approved as a rider (or promoted to admin) loses customer access immediately.
const verifyCustomer = async (req, res, next) => {
  try {
    const user = await client
      .db(DB_NAME)
      .collection("usersCollection")
      .findOne({ email: req.user.email }, { projection: { role: 1 } });

    if (user?.role !== "customer") {
      return res.status(403).send({ message: "Forbidden: Customer only" });
    }
    next();
  } catch (error) {
    res.status(500).send({ message: "Failed to verify account role" });
  }
};

export default verifyCustomer;