# Diagrams

This chapter demonstrates Mermaid diagram rendering across multiple diagram types.

## Flowchart

```mermaid
flowchart TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    D --> E[Fix the bug]
    E --> B
    C --> F[Deploy]
```

## Sequence Diagram

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant DB

    Client->>API: POST /login
    API->>DB: SELECT user WHERE email=?
    DB-->>API: user record
    API-->>Client: 200 OK + JWT token

    Client->>API: GET /data (Bearer token)
    API->>API: Verify JWT
    API->>DB: SELECT data WHERE user_id=?
    DB-->>API: rows
    API-->>Client: 200 OK + JSON payload
```

## Class Diagram

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +speak() String
    }

    class Dog {
        +String breed
        +fetch() void
        +speak() String
    }

    class Cat {
        +bool indoor
        +purr() void
        +speak() String
    }

    Animal <|-- Dog
    Animal <|-- Cat
```

## Entity Relationship

```mermaid
erDiagram
    USER {
        int id PK
        string email
        string name
        datetime created_at
    }

    POST {
        int id PK
        int user_id FK
        string title
        text body
        datetime published_at
    }

    COMMENT {
        int id PK
        int post_id FK
        int user_id FK
        text body
    }

    USER ||--o{ POST : "writes"
    POST ||--o{ COMMENT : "has"
    USER ||--o{ COMMENT : "writes"
```

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Approved : approve
    Review --> Draft : request changes
    Approved --> Published : publish
    Published --> Archived : archive
    Archived --> [*]
```

## Multi-line Labels and Quotes

Node labels can use `\n` for line breaks and escaped quotes for embedded
quotation marks — both are rewritten automatically so Mermaid renders them
correctly instead of showing literal backslashes:

```mermaid
flowchart TD
    A["Request received\nvalidated by middleware"] --> B{Cache hit?}
    B -->|Yes| C["Serve from cache"]
    B -->|No| D["Query source: \"users\" table"]
    D --> E["Response cached\nfor 60s"]
```