import express from "express";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyAdmin } from "../middleware/verifyRole.js";
import { ADMIN_EMAIL } from "../config/admin.js";
import { saveNotification } from "../services/notifications.js";
import { escapeRegex, pageParams, searchTerm } from "../utils/queryHelpers.js";
import { parseRiderProfile, text } from "../utils/riderProfile.js";

export default (
  usersCollection,
  rolesCollection,
  ridersCollection,
  notificationsCollection,
) => {
  const router = express.Router();

  // What the client needs to route a signed-in person: their role (from the
  // database) and whether onboarding is still open.
  const describeAccount = async (user) => {
    const roleDoc = user.role
      ? await rolesCollection.findOne({ key: user.role })
      : null;
    const riderProfile = roleDoc?.requiresApproval
      ? await ridersCollection.findOne(
          { email: user.email },
          { projection: { status: 1, rejectionReason: 1 } },
        )
      : null;

    return {
      email: user.email,
      name: user.name || "",
      photo: user.photo || "",
      role: roleDoc?.key || null,
      roleLabel: roleDoc?.label || null,
      riderStatus: riderProfile?.status || null,
      rejectionReason: riderProfile?.rejectionReason || "",
      needsOnboarding:
        !roleDoc || Boolean(roleDoc.requiresApproval && !riderProfile),
    };
  };

  router.get("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const { page, limit } = pageParams(req.query);
      const term = searchTerm(req.query.search);
      const clauses = [];

      if (term) {
        const pattern = new RegExp(escapeRegex(term), "i");
        clauses.push({ $or: [{ name: pattern }, { email: pattern }] });
      }

      if (req.query.role === "none") {
        clauses.push({ $or: [{ role: null }, { role: { $exists: false } }] });
      } else if (req.query.role) {
        clauses.push({ role: String(req.query.role) });
      }

      if (req.query.provider === "password") {
        // Accounts made before the provider was stored are email and password accounts.
        clauses.push({
          $or: [{ providerId: "password" }, { providerId: null }, { providerId: "" }, { providerId: { $exists: false } }],
        });
      } else if (req.query.provider) {
        clauses.push({ providerId: String(req.query.provider) });
      }

      const query = clauses.length ? { $and: clauses } : {};

      const sorts = {
        newest: { createdAt: -1, _id: -1 },
        oldest: { createdAt: 1, _id: 1 },
        name: { name: 1 },
      };

      const [users, total, roleRows] = await Promise.all([
        usersCollection
          .find(query)
          .sort(sorts[req.query.sort] || sorts.newest)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        usersCollection.countDocuments(query),
        usersCollection.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]).toArray(),
      ]);

      const roleCounts = Object.fromEntries(roleRows.map(({ _id, count }) => [_id || "none", count]));
      res.send({ users, total, roleCounts });
    } catch (err) {
      res.status(500).send({ message: "Server error", error: err.message });
    }
  });

  router.get("/me", verifyJwt, async (req, res) => {
    try {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }
      res.send(await describeAccount(user));
    } catch (error) {
      res.status(500).send({ message: "Failed to load your account" });
    }
  });

  // Creates the account on first sign-in and records the sign-in time after
  // that. A role is only accepted when the database marks it as selectable,
  // and it is never changed for an account that already exists.
  router.post("/", async (req, res) => {
    try {
      const email = text(req.body?.email);
      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      let roleKey = null;
      if (req.body?.role) {
        const roleDoc = await rolesCollection.findOne({
          key: req.body.role,
          selectable: true,
        });
        if (!roleDoc) {
          return res.status(400).send({ message: "Choose a valid role." });
        }
        roleKey = roleDoc.key;
      }

      const result = await usersCollection.updateOne(
        { email },
        {
          $set: { last_log_in: Date.now().toString() },
          $setOnInsert: {
            email,
            name: text(req.body?.name),
            photo: text(req.body?.photo),
            providerId: text(req.body?.providerId) || null,
            role: roleKey,
            createdAt: req.body?.createdAt || Date.now().toString(),
          },
        },
        { upsert: true },
      );

      res.send({ isNew: Boolean(result.upsertedId) });
    } catch (error) {
      res.status(500).send({ message: "Failed to save your account" });
    }
  });

  // Finishes onboarding: stores the chosen role and, for a role that needs
  // approval, the profile an admin reviews.
  router.post("/onboarding", verifyJwt, async (req, res) => {
    try {
      const { email } = req.user;
      const roleDoc = await rolesCollection.findOne({
        key: req.body?.role,
        selectable: true,
      });
      if (!roleDoc) {
        return res.status(400).send({ message: "Choose a valid role." });
      }

      const user = await usersCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      const account = await describeAccount(user);
      if (!account.needsOnboarding) {
        return res.status(409).send({ message: "Your role is already set." });
      }

      if (roleDoc.requiresApproval) {
        const { profile, error } = parseRiderProfile(req.body?.profile);
        if (error) {
          return res.status(400).send({ message: error });
        }

        const appliedAt = new Date().toISOString();
        const saved = await ridersCollection.updateOne(
          { email },
          {
            $set: profile,
            $setOnInsert: {
              name: user.name,
              email,
              status: "pending",
              appliedAt,
            },
          },
          { upsert: true },
        );

        if (saved.upsertedId) {
          await saveNotification(notificationsCollection, {
            type: "direct",
            email,
            message: `Your ${roleDoc.label.toLowerCase()} application is with the Sam's Kitchen team for review.`,
            relatedId: saved.upsertedId.toString(),
            createdAt: appliedAt,
            isRead: false,
          });
          await saveNotification(notificationsCollection, {
            type: "direct",
            email: ADMIN_EMAIL,
            message: `${user.name || email} applied to become a ${roleDoc.label.toLowerCase()}.`,
            relatedId: saved.upsertedId.toString(),
            createdAt: appliedAt,
            isRead: false,
          });
        }
      }

      await usersCollection.updateOne(
        { email },
        { $set: { role: roleDoc.key, onboardedAt: new Date().toISOString() } },
      );

      res.send(await describeAccount({ ...user, role: roleDoc.key }));
    } catch (error) {
      res.status(500).send({ message: "Failed to save your role" });
    }
  });

  router.patch("/", verifyJwt, async (req, res) => {
    try {
      const { name, photo } = req.body;
      const email = req.user.email;

      const result = await usersCollection.updateOne(
        { email },
        { $set: { name, photo } },
      );
      res.send(result);
    } catch (_) {
      res.status(500).send({
        success: false,
        message: "Internal server error while updating profile",
      });
    }
  });

  return router;
};
