import express from "express";

export default (rolesCollection) => {
  const router = express.Router();

  // Role definitions (labels, descriptions, which ones people can pick).
  router.get("/", async (req, res) => {
    try {
      const roles = await rolesCollection
        .find({}, { projection: { _id: 0 } })
        .sort({ order: 1 })
        .toArray();
      res.send(roles);
    } catch (error) {
      res.status(500).send({ message: "Failed to load roles" });
    }
  });

  return router;
};
