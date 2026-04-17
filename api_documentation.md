# Black Barber API Documentation

This API serves the Black Barber admin dashboard and processes external leads. It relies on a secure JWT-based authentication system using HttpOnly Cookies.

## Base URL
`http://localhost:3333/api` (Development)

---

## 1. Authentication Routes

### Register new Admin
Creates a new administrative user to access the dashboard.
- **Endpoint**: `POST /auth/register`
- **Security Check**: Requires a custom header `x-master-key` containing the string defined in your `MASTER_CLIENT_SECRET_KEY` env variable.
- **Body Payload**:
```json
{
  "email": "admin@blackbarber.com",
  "password": "securepassword123"
}
```
- **Returns**: `201 Created` with the masked user object.

### Login Admin
Authenticates the user, generating an Access Token (JSON) and a Refresh Token (HttpOnly Cookie).
- **Endpoint**: `POST /auth/login`
- **Security Check**: Public.
- **Body Payload**:
```json
{
  "email": "admin@blackbarber.com",
  "password": "securepassword123"
}
```
- **Returns**: `200 OK`
```json
{
  "user": { "id": "uuid", "email": "admin@..." },
  "access_token": "eyJhbGciOi..."
}
```

### Refresh Token
Consumes an active refresh cookie to fetch a fresh access token without asking the user for credentials.
- **Endpoint**: `POST /auth/refresh`
- **Security Check**: Requires `refresh_token` injected into the cookie header.
- **Returns**: `200 OK`
```json
{
  "access_token": "eyJhbGciOi..."
}
```

### Logout
Clears the active session cookies.
- **Endpoint**: `POST /auth/logout`
- **Returns**: `200 OK`

---

## 2. Customer & Lead Routes

### Create Lead (Public Webhook)
Generates an entry when a customer buys/subscribes via the Landing Page.
- **Endpoint**: `POST /leads`
- **Security Check**: Public.
- **Body Payload**:
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "(11) 99999-9999",
  "plan": "Plano Black",
  "payment_method": "Credit Card",
  "payment_status": "pending" 
}
```
- **Returns**: `201 Created`.

### List Customers (Admin)
Fetches completely all customer history.
- **Endpoint**: `GET /customers`
- **Security Check**: Requires Bearer Access Token in Header `Authorization: Bearer <token>`
- **Returns**: `200 OK` Array of mapped customer objects.

### Update Customer ERP Status (Admin)
Flags a customer as migrated/registered in the third party ERP manually by the administrator.
- **Endpoint**: `PATCH /customers/:id/erp-status`
- **Security Check**: Requires Bearer Access Token.
- **Body Payload**:
```json
{
  "erp_status": "registered"
}
```
- **Returns**: `200 OK` with success message.
