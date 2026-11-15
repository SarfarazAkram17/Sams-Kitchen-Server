import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyAdmin, verifyCustomer } from "../middleware/verifyRole.js";
import { pageParams, searchTerm } from "../utils/queryHelpers.js";
import {
  checkPromo,
  normalizeCode,
  parsePromoInput,
  promoState,
} from "../utils/promo.js";

// The status tabs on the admin page: a code that is used up counts as expired.
const tabOf = (state) => (state === "used_up" ? "expired" : state);

const SORTS = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  code: (a, b) => a.code.localeCompare(b.code),
  used: (a, b) => (b.usedCount || 0) - (a.usedCount || 0),
};

export default (promosCollection, ordersCollection) => {
  // Admin: every promo code, filtered, searched and paged.
  router.get("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const now = new Date();
      const all = (await promosCollection.find().toArray()).map((promo) => ({
        ...promo,
        state: promoState(promo, now),
      }));

      const counts = {
        all: all.length,
        active: 0,
        scheduled: 0,
        expired: 0,
        disabled: 0,
      };
      all.forEach((promo) => {
        counts[tabOf(promo.state)] += 1;
      });

      const status = ["active", "scheduled", "expired", "disabled"].includes(
        req.query.status,
      )
        ? req.query.status
        : "";
      const text = searchTerm(req.query.search).toLowerCase();
      const sort = SORTS[req.query.sort] || SORTS.newest;

      const matching = all
        .filter((promo) => !status || tabOf(promo.state) === status)
        .filter(
          (promo) =>
            !text ||
            promo.code.toLowerCase().includes(text) ||
            (promo.description || "").toLowerCase().includes(text),
        )
        .sort(sort);

      const { page, limit } = pageParams(req.query);
      res.send({
        promos: matching.slice((page - 1) * limit, page * limit),
        total: matching.length,
        counts,
        page,
        limit,
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to load promo codes" });
    }
  });

  router.post("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const { data, error } = parsePromoInput(req.body || {}, {
        creating: true,
      });
      if (error) return res.status(400).send({ message: error });

      const now = new Date().toISOString();
      const promo = { ...data, usedCount: 0, createdAt: now, updatedAt: now };

      try {
        const result = await promosCollection.insertOne(promo);
        res.status(201).send({ insertedId: result.insertedId });
      } catch (insertError) {
        if (insertError?.code === 11000) {
          return res
            .status(409)
            .send({ message: "A promo code with this name already exists." });
        }
        throw insertError;
      }
    } catch (error) {
      res.status(500).send({ message: "Failed to create the promo code" });
    }
  });

  // Admin: edit a code, or just switch it on or off with { active }.
  router.patch("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid promo code ID" });
      }
      const body = req.body || {};
      let update;

      if (Object.keys(body).length === 1 && typeof body.active === "boolean") {
        update = { active: body.active };
      } else {
        const { data, error } = parsePromoInput(body, { creating: false });
        if (error) return res.status(400).send({ message: error });
        update = data;
      }

      const result = await promosCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...update, updatedAt: new Date().toISOString() } },
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Promo code not found" });
      }
      res.send({ modifiedCount: result.modifiedCount });
    } catch (error) {
      res.status(500).send({ message: "Failed to update the promo code" });
    }
  });

  // Orders keep the code and amount they used, so deleting a code is safe.
  router.delete("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid promo code ID" });
      }
      const result = await promosCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Promo code not found" });
      }
      res.send({ deletedCount: result.deletedCount });
    } catch (error) {
      res.status(500).send({ message: "Failed to delete the promo code" });
    }
  });

  // Customer: preview a code for checkout. `amount` is the food total after food
  // discounts. Placing the order checks the code again, so this is only a preview.
  router.post("/validate", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const code = normalizeCode(req.body?.code);
      if (!code)
        return res.status(400).send({ message: "Enter a promo code." });

      const promo = await promosCollection.findOne({ code });
      if (!promo) {
        return res
          .status(404)
          .send({ message: "This promo code does not exist." });
      }

      const check = checkPromo(promo, req.body?.amount);
      if (!check.ok) return res.status(400).send({ message: check.message });

      const timesUsed = await ordersCollection.countDocuments({
        "customer.email": req.user.email,
        promoCode: code,
        status: { $ne: "cancelled" },
      });
      if (timesUsed >= (promo.perUserLimit || 1)) {
        return res
          .status(409)
          .send({ message: "You have already used this promo code." });
      }

      res.send({
        code: promo.code,
        description: promo.description || "",
        type: promo.type,
        value: promo.value,
        maxDiscount: promo.maxDiscount || null,
        discount: check.discount,
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to check the promo code" });
    }
  });

  return router;
};