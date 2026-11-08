import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import axios from "axios";
import stripe from "../config/stripe.js";
import { ADMIN_EMAIL } from "../config/admin.js";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyCustomer } from "../middleware/verifyRole.js";
import { saveNotification } from "../services/notifications.js";

export default (
  ordersCollection,
  paymentsCollection,
  notificationsCollection,
) => {
  router.post("/create-ssl-payment", verifyJwt, verifyCustomer, async (req, res) => {
    const store_id = process.env.STORE_ID;
    const store_passwd = process.env.STORE_PASSWORD;

    const payment = req.body;
    if (!ObjectId.isValid(String(payment.orderId || ""))) {
      return res.status(400).send({ message: "Invalid order ID" });
    }
    const order = await ordersCollection.findOne({
      _id: new ObjectId(payment.orderId),
      "customer.email": req.user.email,
      payment_status: { $ne: "paid" },
      status: "pending",
    });
    if (!order) {
      return res.status(404).send({ message: "Payable order not found" });
    }
    payment.email = req.user.email;

    const tran_id = new ObjectId().toString();
    payment.transactionId = tran_id;

    const initiate = {
      store_id,
      store_passwd,
      total_amount: Math.round(order.total),
      currency: "BDT",
      tran_id,
      success_url: "https://sams-kitchen.vercel.app/payments/success-payment",
      fail_url: "https://sams-kitchen.vercel.app/payments/fail-payment",
      cancel_url: "https://sams-kitchen.vercel.app/payments/cancel-payment",
      ipn_url: "https://sams-kitchen.vercel.app/payments/ipn-success-payment",
      shipping_method: "Courier",
      product_name: "Foods",
      product_category: "Food",
      product_profile: "general",
      cus_name: payment.name,
      cus_email: payment.email,
      cus_add1: order.customer.address.district,
      cus_city: order.customer.address.thana,
      cus_state: order.customer.address.region,
      cus_country: "Bangladesh",
      cus_phone: order.customer.phone,
      ship_name: payment.name,
      ship_add1: order.customer.address.district,
      ship_city: order.customer.address.thana,
      ship_state: order.customer.address.region,
      ship_postcode: 1000,
      ship_country: "Bangladesh",
    };

    const iniRes = await axios({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      method: "POST",
      data: initiate,
      headers: { "Content-type": "application/x-www-form-urlencoded" },
    });

    const gatewayUrl = iniRes?.data?.GatewayPageURL;

    await paymentsCollection.insertOne(payment);

    res.status(201).send({ gatewayUrl });
  });

  router.post("/success-payment", async (req, res) => {
    const paymentSuccess = req.body;
    const query = { transactionId: paymentSuccess.tran_id };
    const payment = await paymentsCollection.findOne(query);
    if (!payment || !ObjectId.isValid(String(payment.orderId || ""))) {
      return res.status(404).send({ message: "Payment record not found" });
    }
    const orderId = new ObjectId(payment.orderId);
    const order = await ordersCollection.findOne({ _id: orderId });
    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    const store_id = process.env.STORE_ID;
    const store_passwd = process.env.STORE_PASSWORD;

    const isValidPayment = await axios.get(
      `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=${paymentSuccess.val_id}&store_id=${store_id}&store_passwd=${store_passwd}`,
    );

    if (isValidPayment?.data?.status === "VALID") {
      const isFirstSuccessfulPayment = order.payment_status !== "paid";
      if (isFirstSuccessfulPayment) {
        const paidAt = new Date().toISOString();
        const result = await ordersCollection.updateOne(
          {
            _id: orderId,
            payment_status: { $ne: "paid" },
            status: "pending",
          },
          {
            $set: {
              payment_status: "paid",
              status: "confirmed",
              paidAt,
            },
          },
        );
        if (!result.modifiedCount) {
          return res
            .status(409)
            .send({ message: "Order is no longer payable" });
        }
      }

      const updatedPayment = {
        $set: {
          status: "payment done",
          paidAt: new Date().toISOString(),
        },
      };
      await paymentsCollection.updateOne(query, updatedPayment);

      if (isFirstSuccessfulPayment) {
        const createdAt = new Date().toISOString();
        await Promise.all([
          saveNotification(notificationsCollection, {
            type: "direct",
            email: payment.email,
            message:
              "Your payment is successful. You can view your receipt in My Orders.",
            relatedId: payment.orderId.toString(),
            createdAt,
            isRead: false,
          }),
          saveNotification(notificationsCollection, {
            type: "direct",
            email: ADMIN_EMAIL,
            message: "Payment received. The order is confirmed and ready to be prepared.",
            relatedId: payment.orderId.toString(),
            createdAt,
            isRead: false,
          }),
        ]);
      }

      return res.redirect(
        "https://sams-kitchen.netlify.app/dashboard/myOrders",
      );
    } else {
      await paymentsCollection.deleteOne(query);
      res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
      return res.send({ message: "Invalid payment" });
    }
  });

  router.post("/fail-payment", async (req, res) => {
    const failPayment = req.body;
    const query = { transactionId: failPayment.tran_id };
    await paymentsCollection.deleteOne(query);
    return res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
  });

  router.post("/cancel-payment", async (req, res) => {
    const cancelPayment = req.body;
    const query = { transactionId: cancelPayment.tran_id };
    await paymentsCollection.deleteOne(query);
    return res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
  });

  router.post("/create-payment-intent", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(Number(req.body.amountInCents) || 0),
        currency: "bdt",
        payment_method_types: ["card"],
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      res.status(500).json({ error: error.message });
      console.log(error)
    }
  });

  router.post("/", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { orderId, amount, paymentMethod, transactionId } = req.body;
      if (!ObjectId.isValid(String(orderId || ""))) {
        return res.status(400).send({ message: "Invalid order ID" });
      }

      const updateResult = await ordersCollection.updateOne(
        {
          _id: new ObjectId(orderId),
          "customer.email": req.user.email,
          payment_status: { $ne: "paid" },
          status: "pending",
        },
        {
          $set: {
            payment_status: "paid",
            status: "confirmed",
            paidAt: new Date().toISOString(),
          },
        },
      );

      if (updateResult.modifiedCount === 0) {
        return res
          .status(404)
          .send({ message: "Order not found or already paid" });
      }

      const paymentDoc = {
        orderId,
        email: req.user.email,
        amount: Math.round(Number(amount) || 0),
        paymentMethod,
        transactionId,
        paidAt: new Date().toISOString(),
        status: "payment done",
      };

      const paymentResult = await paymentsCollection.insertOne(paymentDoc);

      const notificationForUser = {
        type: "direct",
        email: req.user.email,
        message: `Your payment is successfully done. Go to my orders and you can download your reciept.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `Payment received. The order is confirmed and ready to be prepared.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

      res.status(201).send({
        message: "Payment recorded and parcel marked as paid",
        insertedId: paymentResult.insertedId,
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to record payment" });
    }
  });

  return router;
};
