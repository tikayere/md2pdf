# Code Examples

This chapter demonstrates syntax-highlighted code blocks across multiple languages.

## JavaScript

Async/await with structured error handling:

```javascript
// Fetch a user from the API with full error handling
async function fetchUser(id) {
  try {
    const response = await fetch(`/api/users/${id}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const user = await response.json();
    return user;

  } catch (err) {
    console.error('Failed to fetch user:', err.message);
    throw err;
  }
}

// Parallel fetching with Promise.all
async function fetchDashboard(userId) {
  const [user, posts, notifications] = await Promise.all([
    fetchUser(userId),
    fetch(`/api/users/${userId}/posts`).then(r => r.json()),
    fetch(`/api/notifications`).then(r => r.json()),
  ]);

  return { user, posts, notifications };
}
```

## Python

A typed dataclass with password hashing:

```python
from dataclasses import dataclass
from typing import Optional
import hashlib
import secrets

@dataclass
class User:
    id: int
    email: str
    name: str
    password_hash: Optional[str] = None

    @classmethod
    def create(cls, id: int, email: str, name: str, password: str) -> "User":
        salt = secrets.token_hex(16)
        hashed = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
        return cls(id=id, email=email, name=name, password_hash=f"{salt}:{hashed}")

    def verify_password(self, password: str) -> bool:
        if not self.password_hash:
            return False
        salt, expected = self.password_hash.split(":", 1)
        actual = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
        return secrets.compare_digest(actual, expected)
```

## SQL

Schema creation with indexed queries:

```sql
-- Users table with audit timestamps
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);

-- Get top authors by published post count
SELECT
    u.id,
    u.name,
    u.email,
    COUNT(p.id)          AS post_count,
    MAX(p.published_at)  AS last_published
FROM  users u
LEFT JOIN posts p
       ON p.user_id = u.id
      AND p.published_at IS NOT NULL
GROUP BY u.id, u.name, u.email
ORDER BY post_count DESC
LIMIT 20;
```

## Bash

A deployment script with safety checks:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP="my-app"
TARGET="/var/www/${APP}"
BACKUP="/var/backups/${APP}-$(date +%Y%m%d-%H%M%S)"

echo "→ Backing up current release to ${BACKUP}"
cp -r "${TARGET}" "${BACKUP}"

echo "→ Pulling latest changes"
git -C "${TARGET}" pull --ff-only origin main

echo "→ Installing dependencies"
npm ci --prefix "${TARGET}" --omit=dev

echo "→ Restarting service"
systemctl restart "${APP}"

echo "✅ Deployment complete"
```

## Feature Comparison Table

| Feature          | KaTeX   | MathJax | MathML  |
|------------------|---------|---------|---------|
| Render speed     | Fast    | Slow    | Native  |
| Browser support  | All     | All     | Partial |
| TeX coverage     | Most    | Full    | Limited |
| PDF output       | ✅      | ✅      | ⚠️      |
| Bundle size      | Small   | Large   | None    |
| Sync rendering   | ✅      | ❌      | N/A     |