// Role guards. They run after verifyJwt, which loads req.user.role from the database.
const requireRole = (key, message) => (req, res, next) => {
  if (req.user?.role !== key) {
    return res.status(403).send({ message });
  }
  next();
};

export const verifyAdmin = requireRole("admin", "Forbidden: Admins only");
export const verifyRider = requireRole("rider", "Forbidden: Riders only");
export const verifyCustomer = requireRole("customer", "Forbidden: Customers only");
