export const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const searchTerm = (value) => (typeof value === "string" ? value.trim().slice(0, 80) : "");

export const pageParams = (query, { limit = 10, max = 50 } = {}) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(max, Math.max(1, Number.parseInt(query.limit, 10) || limit)),
});

// Search across an order: its id, the customer, the delivery address and the dishes.
export const orderSearchClause = (term) => {
  const text = searchTerm(term);
  if (!text) return null;
  const pattern = new RegExp(escapeRegex(text), "i");
  return {
    $or: [
      { $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: escapeRegex(text), options: "i" } } },
      { "customer.firstName": pattern },
      { "customer.lastName": pattern },
      { "customer.phone": pattern },
      { "customer.address.street": pattern },
      { "customer.address.thana": pattern },
      { "customer.address.district": pattern },
      { "items.name": pattern },
    ],
  };
};

// Joins a base filter with optional extra clauses.
export const withClauses = (base, ...clauses) => {
  const extra = clauses.filter(Boolean);
  return extra.length ? { $and: [base, ...extra] } : base;
};
