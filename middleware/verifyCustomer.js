const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({ message: "Forbidden: Customer only" });
  }
  next();
};

module.exports = verifyCustomer;