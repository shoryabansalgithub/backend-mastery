# Lesson 1: TypeScript for Backend Development

## Why TypeScript on the Backend?

You might think TypeScript is a "frontend thing." After all, it was created to tame
large-scale JavaScript applications in the browser. But here's the thing: the problems
TypeScript solves -- catching bugs before runtime, making refactoring safe, documenting
intent through types -- are *more* important on the backend, not less.

Why? Because backend bugs are expensive.

A frontend bug might show a broken button. A backend bug might:
- Corrupt your database
- Charge a customer twice
- Leak personal data
- Bring down every client that depends on your API

TypeScript won't prevent all bugs. But it eliminates entire *categories* of bugs -- the
ones where you pass the wrong type, forget a field, or mishandle a null value. On the
backend, that matters enormously.

### The Real Argument

Think of types as a form of automated documentation that the compiler actually enforces.
In a large backend codebase, you might have dozens of services, hundreds of functions, and
thousands of data shapes moving between them. Without types, every function boundary is a
trust exercise. With types, the compiler verifies that trust.

```typescript
// Without types: What does this return? What can userId be?
// You'd have to read the implementation to know.
function getUser(userId) {
  // ...
}

// With types: The function signature IS the documentation.
// And the compiler enforces it.
function getUser(userId: string): Promise<User | null> {
  // ...
}
```

---

## Setting Up Strict Mode

The first thing you do in any TypeScript backend project: enable strict mode. Always.

If you're not using strict mode, you're not really using TypeScript. You're using
"JavaScript with slightly better autocomplete."

### What strict mode enables

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true
  }
}
```

That single flag turns on *all* of these:

| Flag                         | What it does                                      |
|------------------------------|--------------------------------------------------|
| `strictNullChecks`           | `null` and `undefined` aren't assignable to everything |
| `noImplicitAny`              | You can't accidentally leave types as `any`       |
| `strictFunctionTypes`        | Function parameter types are checked properly     |
| `strictBindCallApply`        | `bind`, `call`, `apply` are type-checked          |
| `strictPropertyInitialization`| Class properties must be initialized             |
| `noImplicitThis`             | `this` must have an explicit type                 |
| `alwaysStrict`               | Emits `"use strict"` in every file                |
| `useUnknownInCatchVariables` | `catch(e)` gives `unknown`, not `any`             |

### What Would Happen If You Didn't Use Strict Mode?

```typescript
// Without strictNullChecks:
function getUser(id: string): User {
  const user = database.find(id);
  // user might be undefined, but TypeScript won't warn you
  return user; // No error! This compiles fine!
}

// Later, in production:
const user = getUser("nonexistent");
console.log(user.name); // 💥 Runtime error: Cannot read property 'name' of undefined
```

With strict mode on, TypeScript would force you to handle the `null`/`undefined` case.
The bug never makes it to production.

```typescript
// With strictNullChecks:
function getUser(id: string): User | null {
  const user = database.find(id);
  return user ?? null;
}

const user = getUser("nonexistent");
// TypeScript ERROR: 'user' is possibly 'null'
console.log(user.name);

// You MUST handle it:
if (user) {
  console.log(user.name); // Safe
}
```

---

## The Type System: Your Backend's Immune System

Think of the type system as your application's immune system. It detects foreign bodies
(bugs) before they can cause disease (production incidents). Let's build up your
understanding piece by piece.

### Interfaces vs Types

Both define the shape of data. The difference is subtle but matters.

```typescript
// Interface: describes the shape of an object
// Think of it as a "contract" that objects must fulfill
interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

// Type alias: can describe anything -- objects, unions, primitives, etc.
// Think of it as a "name" for any type expression
type UserId = string;
type Status = "active" | "inactive" | "banned";
type UserOrError = User | Error;
```

**When to use which:**

Use **interfaces** when defining the shape of objects, especially when they might be
extended or implemented by classes:

```typescript
interface Repository<T> {
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  save(entity: T): Promise<T>;
  delete(id: string): Promise<boolean>;
}

// Interfaces can be extended
interface UserRepository extends Repository<User> {
  findByEmail(email: string): Promise<User | null>;
}

// Interfaces can be implemented by classes
class PostgresUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> { /* ... */ }
  async findAll(): Promise<User[]> { /* ... */ }
  async save(entity: User): Promise<User> { /* ... */ }
  async delete(id: string): Promise<boolean> { /* ... */ }
  async findByEmail(email: string): Promise<User | null> { /* ... */ }
}
```

Use **type aliases** for unions, intersections, mapped types, or when you need more
expressive type transformations:

```typescript
// Union types -- only possible with `type`
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

// Intersection types
type AdminUser = User & { permissions: string[] };

// Conditional types
type ApiResponse<T> = T extends Error ? { error: string } : { data: T };

// Template literal types
type EventName = `on${Capitalize<string>}`;
```

### What Would Happen If You Used `any` Everywhere?

```typescript
// The "any" escape hatch -- DON'T DO THIS
function processPayment(amount: any, currency: any, userId: any): any {
  // TypeScript can't help you here. You're back to JavaScript.
  // Did someone pass a negative amount? A number for userId?
  // Who knows! Good luck in production.
  return fetch("/api/pay", {
    body: JSON.stringify({ amount, currency, userId }),
  });
}

// These all compile without errors:
processPayment("not a number", 42, { oops: true });
processPayment(-100, null, undefined);
processPayment(); // Even this compiles!
```

Now compare:

```typescript
interface PaymentRequest {
  amount: number;
  currency: "USD" | "EUR" | "GBP";
  userId: string;
}

interface PaymentResult {
  transactionId: string;
  status: "completed" | "pending" | "failed";
}

async function processPayment(request: PaymentRequest): Promise<PaymentResult> {
  if (request.amount <= 0) {
    throw new Error("Amount must be positive");
  }
  // TypeScript guarantees the shape of both input and output
  // ...
}

// These are now compile-time errors:
processPayment("not a number", 42, { oops: true }); // Error!
processPayment({ amount: -100, currency: "FAKE", userId: 123 }); // Multiple errors!
```

---

## Generics: Writing Code That Works with Any Type (Safely)

Generics let you write functions and types that work with multiple types while maintaining
type safety. Think of them as "type parameters" -- just like function parameters let you
pass different values, generics let you pass different *types*.

### The Problem Generics Solve

```typescript
// BAD: You want a function that wraps any value in an array.
// Without generics, you lose type information:
function wrapInArray(value: any): any[] {
  return [value];
}

const result = wrapInArray("hello");
// result is any[] -- TypeScript forgot it contains strings!
result[0].toUpperCase(); // No autocomplete, no type checking
```

```typescript
// GOOD: With generics, the type flows through:
function wrapInArray<T>(value: T): T[] {
  return [value];
}

const strings = wrapInArray("hello");
// strings is string[] -- TypeScript remembers!
strings[0].toUpperCase(); // Full autocomplete and type checking

const numbers = wrapInArray(42);
// numbers is number[]
numbers[0].toFixed(2); // Works!
```

### Generic Constraints

Sometimes you need generics that aren't *completely* open. You want to say "any type,
as long as it has these properties."

```typescript
// This won't work -- T could be anything, even a number
function getId<T>(entity: T): string {
  return entity.id; // Error: Property 'id' does not exist on type 'T'
}

// Constrain T to types that have an 'id' property
function getId<T extends { id: string }>(entity: T): string {
  return entity.id; // Now TypeScript knows entity has 'id'
}

// Works with any object that has a string 'id':
getId({ id: "abc", name: "Alice" }); // OK
getId({ id: "xyz", email: "b@c.com", age: 30 }); // OK
getId({ name: "No ID" }); // Error: missing 'id'
```

### Generics in Backend Patterns

Generics shine in backend code. Here's a practical example -- a generic repository
pattern:

```typescript
interface Entity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Repository<T extends Entity> {
  findById(id: string): Promise<T | null>;
  findAll(filter?: Partial<T>): Promise<T[]>;
  create(data: Omit<T, "id" | "createdAt" | "updatedAt">): Promise<T>;
  update(id: string, data: Partial<Omit<T, "id" | "createdAt" | "updatedAt">>): Promise<T>;
  delete(id: string): Promise<boolean>;
}

interface User extends Entity {
  email: string;
  name: string;
  role: "admin" | "user";
}

interface Post extends Entity {
  title: string;
  content: string;
  authorId: string;
  published: boolean;
}

// Now you can create type-safe repositories for any entity:
class UserRepository implements Repository<User> {
  async create(data: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User> {
    // TypeScript knows `data` has: email, name, role
    // TypeScript knows the return must be a full User
    const user: User = {
      id: generateId(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // ... save to database ...
    return user;
  }

  // ... other methods ...
}
```

### Generic Utility Functions

```typescript
// A generic retry function -- works with any async operation
async function retry<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  delayMs: number
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

// Usage -- the return type is inferred correctly:
const user = await retry(() => fetchUser("123"), 3, 1000);
// user is User (inferred from fetchUser's return type)

const data = await retry(() => fetch("https://api.example.com").then(r => r.json()), 3, 500);
```

---

## Utility Types: The Backend Developer's Swiss Army Knife

TypeScript ships with built-in utility types that transform existing types. These are
not just convenient -- they're essential for backend development where you constantly
deal with partial updates, projections, and data transformations.

### Pick<T, K> -- Select Specific Fields

When your API endpoint should only return certain fields:

```typescript
interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: Date;
  lastLoginAt: Date;
}

// NEVER send passwordHash to the client!
type PublicUser = Pick<User, "id" | "email" | "name" | "role">;

// PublicUser is equivalent to:
// {
//   id: string;
//   email: string;
//   name: string;
//   role: "admin" | "user";
// }

function sanitizeUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}
```

### Omit<T, K> -- Remove Specific Fields

The inverse of Pick. Useful when you want "everything except":

```typescript
// When creating a user, the server generates id and timestamps
type CreateUserInput = Omit<User, "id" | "createdAt" | "lastLoginAt" | "passwordHash"> & {
  password: string; // Accept plain password, not hash
};

// CreateUserInput is:
// {
//   email: string;
//   name: string;
//   role: "admin" | "user";
//   password: string;
// }
```

### Partial<T> -- Make All Fields Optional

Essential for update operations where you only send changed fields:

```typescript
type UpdateUserInput = Partial<Omit<User, "id" | "createdAt" | "passwordHash">>;

// UpdateUserInput is:
// {
//   email?: string;
//   name?: string;
//   role?: "admin" | "user";
//   lastLoginAt?: Date;
// }

async function updateUser(id: string, updates: UpdateUserInput): Promise<User> {
  const existing = await findUser(id);
  if (!existing) throw new Error("User not found");

  return {
    ...existing,
    ...updates,
    updatedAt: new Date(),
  };
}

// Now you can update just the name:
await updateUser("123", { name: "New Name" });
// Or just the role:
await updateUser("123", { role: "admin" });
```

### Required<T> -- Make All Fields Required

The opposite of Partial. Useful for config objects with defaults:

```typescript
interface ServerConfig {
  port?: number;
  host?: string;
  cors?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
}

function createServer(userConfig: ServerConfig): Required<ServerConfig> {
  const defaults: Required<ServerConfig> = {
    port: 3000,
    host: "0.0.0.0",
    cors: false,
    logLevel: "info",
  };

  return { ...defaults, ...userConfig };
}
```

### Record<K, V> -- Create Object Types from Key/Value Types

```typescript
type HttpStatus = 200 | 201 | 400 | 401 | 403 | 404 | 500;
type StatusMessage = Record<HttpStatus, string>;

const statusMessages: StatusMessage = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

// Also great for lookup maps:
type Route = {
  method: string;
  handler: () => void;
};

type Routes = Record<string, Route>;
```

### Readonly<T> -- Immutable Data

Backend services often pass data between layers. Readonly prevents accidental mutation:

```typescript
interface Config {
  databaseUrl: string;
  apiKey: string;
  maxConnections: number;
}

function loadConfig(): Readonly<Config> {
  return Object.freeze({
    databaseUrl: process.env.DATABASE_URL!,
    apiKey: process.env.API_KEY!,
    maxConnections: 10,
  });
}

const config = loadConfig();
config.maxConnections = 20; // Error: Cannot assign to 'maxConnections' because it is a read-only property
```

### Combining Utility Types

The real power comes from composition:

```typescript
interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  status: "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
  totalCents: number;
  shippingAddress: Address;
  createdAt: Date;
  updatedAt: Date;
}

// What the client sends to create an order (no server-generated fields):
type CreateOrderInput = Omit<Order, "id" | "status" | "createdAt" | "updatedAt">;

// What the client can update (only certain fields, all optional):
type UpdateOrderInput = Partial<Pick<Order, "status" | "shippingAddress">>;

// What the API returns (everything except internal fields):
type OrderResponse = Readonly<Omit<Order, "updatedAt">>;

// A summary view for list endpoints:
type OrderSummary = Pick<Order, "id" | "status" | "totalCents" | "createdAt">;
```

---

## Branded Types: Making Illegal States Unrepresentable

This is where TypeScript for backend development gets really interesting. Branded types
(also called "opaque types" or "nominal types") let you create distinct types that are
structurally identical but semantically different.

### The Problem

```typescript
// Both are strings, but they mean completely different things
function transferMoney(fromAccountId: string, toAccountId: string, amount: number): void {
  // ...
}

const fromId = "acc_123";
const toId = "acc_456";

// Oops! Arguments are swapped! TypeScript can't catch this because both are `string`.
transferMoney(toId, fromId, 1000);
// Congratulations, you just sent $1000 to the wrong account.
```

This is a real class of bugs in production systems. Both parameters are `string`, so
TypeScript sees nothing wrong. But the *meaning* is completely different.

### The Solution: Branded Types

```typescript
// Create distinct types that are structurally strings but nominally different
type AccountId = string & { readonly __brand: "AccountId" };
type UserId = string & { readonly __brand: "UserId" };
type TransactionId = string & { readonly __brand: "TransactionId" };

// Constructor functions that "brand" a value
function AccountId(value: string): AccountId {
  // You could add validation here!
  if (!value.startsWith("acc_")) {
    throw new Error(`Invalid account ID: ${value}`);
  }
  return value as AccountId;
}

function UserId(value: string): UserId {
  if (!value.startsWith("usr_")) {
    throw new Error(`Invalid user ID: ${value}`);
  }
  return value as UserId;
}

// Now the compiler catches the bug:
function transferMoney(
  fromAccountId: AccountId,
  toAccountId: AccountId,
  amount: number
): void {
  // ...
}

const fromId = AccountId("acc_123");
const toId = AccountId("acc_456");

transferMoney(toId, fromId, 1000); // Still compiles (both are AccountId)
// But you can't accidentally pass a UserId:

const userId = UserId("usr_789");
transferMoney(userId, fromId, 1000); // ERROR: UserId is not assignable to AccountId
```

### A Generic Brand Utility

```typescript
// Generic branding utility
type Brand<T, B extends string> = T & { readonly __brand: B };

// Now creating branded types is a one-liner:
type TaskId = Brand<string, "TaskId">;
type ProjectId = Brand<string, "ProjectId">;
type Milliseconds = Brand<number, "Milliseconds">;
type Cents = Brand<number, "Cents">;
type Email = Brand<string, "Email">;

// Smart constructor with validation
function Email(value: string): Email {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(value)) {
    throw new Error(`Invalid email: ${value}`);
  }
  return value as Email;
}

function Cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`Cents must be an integer, got: ${value}`);
  }
  return value as Cents;
}

// Usage:
interface Invoice {
  id: Brand<string, "InvoiceId">;
  customerEmail: Email;
  amountCents: Cents;
  tax: Cents;
}

// You can't accidentally use dollars where cents are expected:
const invoice: Invoice = {
  id: "inv_001" as Brand<string, "InvoiceId">,
  customerEmail: Email("alice@example.com"),
  amountCents: Cents(9999), // $99.99
  tax: Cents(800),          // $8.00
};

// This would be a compile error:
// invoice.amountCents = 99.99;  // Error: number is not Cents
// invoice.amountCents = invoice.tax; // OK: both are Cents
```

### What Would Happen Without Branded Types?

Imagine a medical records system:

```typescript
// Without branded types -- a disaster waiting to happen
function prescribeMedication(
  patientId: string,
  medicationId: string,
  dosageMg: number,
  frequencyHours: number
): void { /* ... */ }

// All strings, all numbers. Can you spot the bug?
prescribeMedication(
  "med_aspirin",   // This is the medication ID, not patient ID!
  "patient_12345", // This is the patient ID, not medication ID!
  8,               // Is this dosage or frequency?
  500              // Is this frequency or dosage? 500 hours? 500 mg?
);
// This compiles. This deploys. This hurts someone.
```

With branded types, the compiler catches every one of those mistakes.

---

## Discriminated Unions: Elegant Error Handling

Discriminated unions are one of TypeScript's most powerful features for backend code.
They let you model states that are mutually exclusive -- something is *either* a success
*or* a failure, *either* loading *or* loaded *or* errored.

### The Problem with Traditional Error Handling

```typescript
// The typical approach: throw and hope someone catches
async function getUser(id: string): Promise<User> {
  const user = await db.users.findById(id);
  if (!user) {
    throw new Error("User not found"); // Who catches this? When? Where?
  }
  return user;
}

// The caller has no idea this function can throw.
// TypeScript's type signature says Promise<User>, not Promise<User | Error>.
const user = await getUser("123"); // Looks safe. It isn't.
```

The problem: TypeScript can't track which functions throw and what they throw. The type
system is blind to exceptions. This means errors are invisible in your function signatures.

### The Result Type Pattern

Instead of throwing errors, *return* them as part of your type:

```typescript
// A discriminated union: either success or failure
type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

// Now the function signature tells the WHOLE story:
async function getUser(id: string): Promise<Result<User, "NOT_FOUND" | "DB_ERROR">> {
  try {
    const user = await db.users.findById(id);
    if (!user) {
      return { success: false, error: "NOT_FOUND" };
    }
    return { success: true, data: user };
  } catch {
    return { success: false, error: "DB_ERROR" };
  }
}

// The caller is FORCED to handle both cases:
const result = await getUser("123");

if (result.success) {
  // TypeScript knows result.data is User here
  console.log(result.data.name);
} else {
  // TypeScript knows result.error is "NOT_FOUND" | "DB_ERROR" here
  switch (result.error) {
    case "NOT_FOUND":
      return res.status(404).json({ error: "User not found" });
    case "DB_ERROR":
      return res.status(500).json({ error: "Internal error" });
  }
}
```

### Why This Is Better

1. **Errors are visible in types.** You can see every possible failure mode just by
   reading the function signature.
2. **The compiler forces handling.** You can't accidentally ignore an error case.
3. **No try/catch pyramid.** Error handling is just `if` statements.
4. **Composable.** You can chain Results together.

### Building a Richer Result Type

```typescript
// A more complete Result implementation
type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

// Helper functions for creating Results
function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E extends string>(error: E, message: string): Result<never, E> {
  return { ok: false, error, message };
}

// Usage:
type UserError = "NOT_FOUND" | "INVALID_EMAIL" | "DUPLICATE_EMAIL" | "DB_ERROR";

async function createUser(input: CreateUserInput): Promise<Result<User, UserError>> {
  // Validate email
  if (!isValidEmail(input.email)) {
    return Err("INVALID_EMAIL", `"${input.email}" is not a valid email address`);
  }

  // Check for duplicates
  const existing = await db.users.findByEmail(input.email);
  if (existing) {
    return Err("DUPLICATE_EMAIL", `A user with email "${input.email}" already exists`);
  }

  // Create user
  try {
    const user = await db.users.create(input);
    return Ok(user);
  } catch {
    return Err("DB_ERROR", "Failed to create user in database");
  }
}

// The caller gets exhaustive checking:
const result = await createUser({ email: "alice@example.com", name: "Alice" });

if (!result.ok) {
  switch (result.error) {
    case "NOT_FOUND":
      // handle...
      break;
    case "INVALID_EMAIL":
      // handle...
      break;
    case "DUPLICATE_EMAIL":
      // handle...
      break;
    case "DB_ERROR":
      // handle...
      break;
    // If you add a new error type to UserError, TypeScript will warn you
    // that you're not handling it here (with `noUncheckedIndexedAccess`)
  }
}
```

### Discriminated Unions Beyond Errors

Discriminated unions are useful for modeling any state machine:

```typescript
// An order goes through distinct states, each with different data
type Order =
  | { status: "draft"; items: OrderItem[]; }
  | { status: "placed"; items: OrderItem[]; placedAt: Date; }
  | { status: "paid"; items: OrderItem[]; placedAt: Date; paidAt: Date; transactionId: string; }
  | { status: "shipped"; items: OrderItem[]; placedAt: Date; paidAt: Date; transactionId: string; shippedAt: Date; trackingNumber: string; }
  | { status: "delivered"; items: OrderItem[]; placedAt: Date; paidAt: Date; transactionId: string; shippedAt: Date; trackingNumber: string; deliveredAt: Date; }
  | { status: "cancelled"; items: OrderItem[]; cancelledAt: Date; reason: string; };

function processOrder(order: Order): string {
  switch (order.status) {
    case "draft":
      return "Order is still a draft";
    case "placed":
      return `Order placed at ${order.placedAt}`;
    case "paid":
      return `Payment received: ${order.transactionId}`;
    case "shipped":
      return `Shipped! Tracking: ${order.trackingNumber}`;
    case "delivered":
      return `Delivered at ${order.deliveredAt}`;
    case "cancelled":
      return `Cancelled: ${order.reason}`;
  }
}
```

The key insight: in each branch of the `switch`, TypeScript **narrows** the type. Inside
`case "shipped"`, TypeScript knows `order.trackingNumber` exists. Inside `case "draft"`,
it knows `order.trackingNumber` does NOT exist. You literally cannot access the wrong
fields.

### Exhaustiveness Checking

The holy grail of discriminated unions: the compiler tells you when you forgot a case.

```typescript
// The "never" trick for exhaustive switches
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "rectangle":
      return shape.width * shape.height;
    case "triangle":
      return (shape.base * shape.height) / 2;
    default:
      return assertNever(shape);
      // If you add a new shape kind and forget to handle it,
      // TypeScript will give a compile error here because
      // the new kind is not assignable to `never`.
  }
}
```

---

## Advanced Type Patterns for Backend Work

### Mapped Types for API Validation

```typescript
// Create a validation schema type from your domain type
type ValidationSchema<T> = {
  [K in keyof T]: {
    required: boolean;
    validate: (value: unknown) => value is T[K];
    message: string;
  };
};

interface SignupInput {
  email: string;
  password: string;
  name: string;
  age: number;
}

const signupSchema: ValidationSchema<SignupInput> = {
  email: {
    required: true,
    validate: (v): v is string => typeof v === "string" && v.includes("@"),
    message: "Valid email required",
  },
  password: {
    required: true,
    validate: (v): v is string => typeof v === "string" && v.length >= 8,
    message: "Password must be at least 8 characters",
  },
  name: {
    required: true,
    validate: (v): v is string => typeof v === "string" && v.length > 0,
    message: "Name is required",
  },
  age: {
    required: true,
    validate: (v): v is number => typeof v === "number" && v >= 13,
    message: "Must be at least 13 years old",
  },
};
```

### Template Literal Types for Route Patterns

```typescript
// Type-safe route parameters
type ExtractParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
    ? Param
    : never;

type UserRouteParams = ExtractParams<"/users/:userId/posts/:postId">;
// UserRouteParams = "userId" | "postId"

type RouteHandler<T extends string> = (
  params: Record<ExtractParams<T>, string>
) => void;

// Usage:
const handler: RouteHandler<"/users/:userId/posts/:postId"> = (params) => {
  // TypeScript knows params has exactly userId and postId
  console.log(params.userId);
  console.log(params.postId);
  // console.log(params.foo); // Error!
};
```

### Conditional Types for Response Shaping

```typescript
// Different endpoints return different shapes
type ApiEndpoint = "/users" | "/users/:id" | "/posts" | "/posts/:id";

type ApiResponse<T extends ApiEndpoint> =
  T extends "/users" ? User[] :
  T extends "/users/:id" ? User :
  T extends "/posts" ? Post[] :
  T extends "/posts/:id" ? Post :
  never;

// A type-safe API client:
async function apiCall<T extends ApiEndpoint>(
  endpoint: T
): Promise<ApiResponse<T>> {
  const response = await fetch(endpoint);
  return response.json();
}

// Return types are inferred correctly:
const users = await apiCall("/users");     // User[]
const user = await apiCall("/users/:id");  // User
const posts = await apiCall("/posts");     // Post[]
```

---

## Putting It All Together: A Type-Safe Service Layer

Here's a complete example combining everything we've learned:

```typescript
// --- Domain Types ---

type Brand<T, B extends string> = T & { readonly __brand: B };

type UserId = Brand<string, "UserId">;
type Email = Brand<string, "Email">;

function UserId(value: string): UserId {
  return value as UserId;
}

function Email(value: string): Email {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(value)) {
    throw new Error(`Invalid email: ${value}`);
  }
  return value as Email;
}

interface User {
  id: UserId;
  email: Email;
  name: string;
  role: "admin" | "user";
  createdAt: Date;
}

// --- Result Type ---

type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E extends string>(error: E, message: string): Result<never, E> {
  return { ok: false, error, message };
}

// --- Repository Interface ---

interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  create(user: User): Promise<void>;
  update(id: UserId, data: Partial<Omit<User, "id" | "createdAt">>): Promise<void>;
  delete(id: UserId): Promise<void>;
}

// --- Service Layer ---

type CreateUserError = "INVALID_EMAIL" | "DUPLICATE_EMAIL" | "DB_ERROR";
type GetUserError = "NOT_FOUND" | "DB_ERROR";

class UserService {
  constructor(private readonly repo: UserRepository) {}

  async createUser(
    input: { email: string; name: string; role: "admin" | "user" }
  ): Promise<Result<User, CreateUserError>> {
    // Validate email (branded type constructor handles validation)
    let email: Email;
    try {
      email = Email(input.email);
    } catch {
      return Err("INVALID_EMAIL", `"${input.email}" is not a valid email`);
    }

    // Check for duplicate
    const existing = await this.repo.findByEmail(email);
    if (existing) {
      return Err("DUPLICATE_EMAIL", `Email "${input.email}" is already registered`);
    }

    // Create user
    const user: User = {
      id: UserId(crypto.randomUUID()),
      email,
      name: input.name,
      role: input.role,
      createdAt: new Date(),
    };

    try {
      await this.repo.create(user);
      return Ok(user);
    } catch {
      return Err("DB_ERROR", "Failed to save user");
    }
  }

  async getUser(id: UserId): Promise<Result<User, GetUserError>> {
    try {
      const user = await this.repo.findById(id);
      if (!user) {
        return Err("NOT_FOUND", `User ${id} not found`);
      }
      return Ok(user);
    } catch {
      return Err("DB_ERROR", "Database query failed");
    }
  }
}
```

This code is self-documenting. Every function tells you exactly what it can return,
what can go wrong, and what types it expects. No surprises at runtime.

---

## Exercises

### Exercise 1: Utility Type Workout

Create the following types for a blog system:

```typescript
interface BlogPost {
  id: string;
  authorId: string;
  title: string;
  content: string;
  tags: string[];
  status: "draft" | "published" | "archived";
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}
```

1. `CreatePostInput` -- what the API accepts to create a post (no server-generated fields)
2. `UpdatePostInput` -- what the API accepts to update a post (all fields optional, no immutable fields)
3. `PostSummary` -- what a list endpoint returns (id, title, status, viewCount, createdAt)
4. `PublishedPost` -- a BlogPost where status is always "published" and publishedAt is always Date (not null)

### Exercise 2: Branded Types

Create branded types for a financial system:
- `AccountId` (must start with "acc_")
- `USD` (cents, must be integer)
- `EUR` (cents, must be integer)

Write a `convertUsdToEur` function that accepts `USD` and returns `EUR`. Make sure
you can't accidentally pass `EUR` to a function expecting `USD`.

### Exercise 3: Result Type

Implement a `parseConfig` function that reads a configuration object and returns a
`Result`. The config must have:
- `port` (number, 1-65535)
- `host` (string, non-empty)
- `dbUrl` (string, must start with "postgres://")

Define specific error types for each validation failure. The caller should be able to
`switch` on the error type and handle each case.

### Exercise 4: Discriminated Union State Machine

Model a `Connection` type that can be in one of these states:
- `disconnected` (no extra data)
- `connecting` (has `startedAt: Date`)
- `connected` (has `connectedAt: Date`, `latencyMs: number`)
- `error` (has `error: string`, `retryCount: number`)

Write a `getStatusMessage` function that returns a human-readable string for each state.
Use the `assertNever` pattern to ensure exhaustiveness.

### Exercise 5: Generic Middleware

Write a generic `validate` function with this signature:

```typescript
function validate<T>(
  data: unknown,
  validators: { [K in keyof T]: (value: unknown) => value is T[K] }
): Result<T, string>
```

It should validate each field and return either the validated object or an error
describing which field failed. Test it with your blog post creation input.
