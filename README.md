# Sam's Kitchen Server — Food Delivery & Kitchen Management Backend

This is the backend for **Sam's Kitchen**, a full-stack food delivery platform where customers order food, riders manage deliveries, and admins control the system with secure authentication, notifications, and multiple payment options.

---

## 🔗 Live Project

- 🌐 **Website**: [https://sams-kitchen.netlify.app](https://sams-kitchen.netlify.app)
- 🧠 **Frontend Repository**: [GitHub – Sam's Kitchen Client](https://github.com/SarfarazAkram17/Sams-Kitchen-Client)

---

## 🧰 Tech Stack

| Package       | Purpose                         |
| ------------- | ------------------------------- |
| `node`        | JavaScript runtime              |
| `express`     | Web framework & routing         |
| `mongodb`     | NoSQL database (Atlas cloud)    |
| `stripe`      | Stripe payment integration      |
| `ssl commerz` | SSLCommerz payment integration  |
| `jwt`         | Custom role-based token system  |
| `dotenv`      | Environment variable management |
| `cors`        | Cross-origin requests support   |

---

## 🔐 Authentication & Security

| Middleware       | Description                              |
| ---------------- | ---------------------------------------- |
| `verifyJwt`      | Validates JWT token for protected routes |
| `verifyAdmin`    | Restricts access to admin                |
| `verifyCustomer` | Restricts access to customers            |
| `verifyRider`    | Restricts access to riders               |

---

## 📦 API Endpoints

### 🗝️ Auth

| Method | Endpoint  | Middleware | Description                   |
| ------ | --------- | ---------- | ----------------------------- |
| `POST` | `/jwt`    | -          | Make token and save in cookie |
| `POST` | `/logout` | -          | Remove cookie when logout     |

---

### 👥 Users

| Method  | Endpoint             | Middleware                 | Description                                                   |
| ------- | -------------------- | -------------------------- | ------------------------------------------------------------- |
| `GET`   | `/users`             | `verifyJwt`, `verifyAdmin` | Get paginated list of users with search/filter only for admin |
| `GET`   | `/users/:email/role` | -                          | Get user role by email                                        |
| `POST`  | `/users`             | -                          | Register or update last login                                 |
| `PATCH` | `/users`             | `verifyJwt`                | Update user profile (name, photo)                             |

---

### 🛒 Orders

| Method  | Endpoint              | Middleware                 | Description                                           |
| ------- | --------------------- | -------------------------- | ----------------------------------------------------- |
| `GET`   | `/orders`             | `verifyJwt`                | Get paginated orders of specific user                 |
| `GET`   | `/orders/:id`         | `verifyJwt`                | Get single order for payment                          |
| `POST`  | `/orders`             | `verifyJwt`                | Place Order                                           |
| `PATCH` | `/orders/:id`         | `verifyJwt`                | Cancel Order when status is pending                   |
| `PATCH` | `/orders/:id/assign`  | `verifyJwt`, `verifyAdmin` | Assign order to a rider                               |
| `PATCH` | `/orders/:id/status`  | `verifyJwt`, `verifyRider` | Rider can update order status to picked and delivered |
| `PATCH` | `/orders/:id/cashout` | `verifyJwt`, `verifyRider` | Update order that the rider cashout his earnings      |

---

### 🛵 Riders

| Method   | Endpoint                  | Middleware                    | Description                                           |
| -------- | ------------------------- | ----------------------------- | ----------------------------------------------------- |
| `GET`    | `/riders/pending`         | `verifyJwt`, `verifyAdmin`    | List pending rider applications                       |
| `GET`    | `/riders/available`       | `verifyJwt`, `verifyAdmin`    | Get available riders by thana to assign for a order   |
| `GET`    | `/riders/orders`          | `verifyJwt`, `verifyRider`    | Rider get their own assigned and not delivered orders |
| `GET`    | `/riders/completedOrders` | `verifyJwt`, `verifyRider`    | Rider get their own completed orders                  |
| `POST`   | `/riders`                 | `verifyJwt`, `verifyCustomer` | Apply to become a rider                               |
| `PATCH`  | `/riders/:id/status`      | `verifyJwt`, `verifyAdmin`    | Approve or update rider status                        |
| `DELETE` | `/riders/:id`             | `verifyJwt`, `verifyAdmin`    | Reject and delete rider application                   |

---

### 💳 Payments

| Method | Endpoint                          | Middleware  | Description                               |
| ------ | --------------------------------- | ----------- | ----------------------------------------- |
| `POST` | `/payments/create-ssl-payment`    | `verifyJwt` | Initiate payment via SSLCommerz           |
| `POST` | `/payments/success-payment`       | -           | Handle SSLCommerz payment success webhook |
| `POST` | `/payments/fail-payment`          | -           | Handle SSLCommerz payment failure webhook |
| `POST` | `/payments/cancel-payment`        | -           | Handle SSLCommerz payment cancel webhook  |
| `POST` | `/payments/create-payment-intent` | `verifyJwt` | Create Stripe payment intent              |
| `POST` | `/payments`                       | `verifyJwt` | Record payment and update order           |

---

### 🛍️ Foods

| Method   | Endpoint              | Middleware                  | Description                             |
| -------- | --------------------- | --------------------------- | --------------------------------------- |
| `GET`    | `/foods`              | -                           | Get paginated list of food items        |
| `GET`    | `/foods/random`       | -                           | Get 6 random food items                 |
| `GET`    | `/foods/offer`        | -                           | Get foods those have discount           |
| `GET`    | `/foods/offer/random` | -                           | Get 3 random foods those have discount  |
| `GET`    | `/foods/search`       | -                           | Get search foods by name                |
| `GET`    | `/foods/:id`          | -                           | Get single food data for food details   |
| `POST`   | `/foods`              | `verifyJwt`, `verifyAdmin`  | Admin can add food                      |
| `POST`   | `/foods/cart`         | -                           | Get those foods which are added to cart |
| `PATCH`  | `/foods/:id`          | `verifyJwt` , `verifyAdmin` | Admin can update food informations      |
| `DELETE` | `/foods/:id`          | `verifyJwt` , `verifyAdmin` | Admin can delete food item              |

---

### ⭐ Reviews

| Method | Endpoint   | Middleware  | Description                                    |
| ------ | ---------- | ----------- | ---------------------------------------------- |
| `GET`  | `/reviews` | -           | Get paginated list of reviews of specific food |
| `Post` | `/reviews` | `verifyJwt` | Add review                                     |

---

### 🔔 Notifications

| Method  | Endpoint         | Middleware  | Description                                                             |
| ------- | ---------------- | ----------- | ----------------------------------------------------------------------- |
| `GET`   | `/notifications` | -           | Get own notifications with limit                                        |
| `PATCH` | `/readAll`       | `verifyJwt` | Update all notifications of specific user to read when that user see it |

---

### 📊 Stats

| Method | Endpoint          | Middleware                    | Description               |
| ------ | ----------------- | ----------------------------- | ------------------------- |
| `GET`  | `/stats/admin`    | `verifyJwt`, `verifyAdmin`    | Admin get his stats       |
| `GET`  | `/stats/customer` | `verifyJwt`, `verifyCustomer` | Customers get their stats |
| `GET`  | `/stats/rider`    | `verifyJwt`, `verifyRider`    | Riders get their stats    |

---

# 🛠️ Getting Started

git clone https://github.com/SarfarazAkram17/Sams-Kitchen-Server.git <br />
cd Sams-Kitchen-Server
