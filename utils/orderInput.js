// Checks the parts of a new order that really do come from the customer: their
// contact and delivery details, and which dishes and how many. Everything else
// (prices, names, totals) is read from the database.

const MAX_LINES = 50;
const MAX_QUANTITY = 100;
const PHONE_PATTERN = /^(?:\+?88)?01[3-9]\d{8}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const text = (value, min, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};

// { data } or { error }. The email always comes from the signed-in account.
export const parseCustomer = (input, email) => {
  const source = input && typeof input === "object" ? input : {};
  const address =
    source.address && typeof source.address === "object" ? source.address : {};

  const firstName = text(source.firstName, 2, 50);
  if (!firstName) return { error: "Enter a first name (2 to 50 characters)." };

  const lastName = text(source.lastName, 2, 50);
  if (!lastName) return { error: "Enter a last name (2 to 50 characters)." };

  const phone = text(source.phone, 1, 20);
  if (!phone || !PHONE_PATTERN.test(phone)) {
    return { error: "Enter a valid Bangladesh mobile number." };
  }

  const street = text(address.street, 1, 200);
  if (!street) return { error: "Enter your street address." };

  const region = text(address.region, 1, 80);
  const district = text(address.district, 1, 80);
  const thana = text(address.thana, 1, 80);
  if (!region || !district || !thana) {
    return { error: "Choose your region, district and thana." };
  }

  return {
    data: {
      firstName,
      lastName,
      email,
      phone,
      address: { street, region, district, thana },
    },
  };
};

// { lines: [{ foodId, quantity }] } or { error }. The same dish twice becomes one line.
export const parseCartLines = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "Your cart is empty." };
  if (raw.length > MAX_LINES) return { error: "Your cart has too many items." };

  const quantities = new Map();
  for (const item of raw) {
    const foodId = typeof item?.foodId === "string" ? item.foodId : "";
    const quantity = Number(item?.quantity);
    if (!OBJECT_ID_PATTERN.test(foodId))
      return { error: "An item in your cart is not valid." };
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: "Item quantities must be whole numbers, 1 or more." };
    }
    quantities.set(foodId, (quantities.get(foodId) || 0) + quantity);
  }

  const lines = [...quantities].map(([foodId, quantity]) => ({
    foodId,
    quantity,
  }));
  if (lines.some((line) => line.quantity > MAX_QUANTITY)) {
    return { error: `You can order at most ${MAX_QUANTITY} of one dish.` };
  }
  return { lines };
};