const verifyRider = (req, res, next) => {
  if (req.user.role !== "rider") {
    return res.status(403).send({ message: "Forbidden: Riders only" });
  }
  next();
};

module.exports = verifyRider;