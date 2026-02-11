# Stremio Letterboxd Backend

Backend Fastify pour l'addon Stremio Letterboxd.

## Prérequis

- Node.js 20+
- Accès API Letterboxd (client_id et client_secret)

## Installation

```bash
npm install
```

## Configuration

Copier `.env.example` vers `.env` et remplir les variables:

```bash
cp .env.example .env
```

Variables requises:
- `ENCRYPTION_KEY` - Clé 64 caractères hex (générer avec `openssl rand -hex 32`)
- `JWT_SECRET` - Secret JWT min 32 caractères

## Développement

```bash
npm run dev
```

Le serveur démarre sur http://localhost:3001

## Tests

```bash
npm test
```

## Endpoints

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/health` | Health check |
| POST | `/auth/login` | Authentification Letterboxd |
| GET | `/v1/resolve-film` | Résolution de film (auth requis) |
| GET | `/v1/film-rating` | Notes du film (auth requis) |
| GET | `/:userToken/manifest.json` | Manifest Stremio |

## Architecture

```
src/
├── config/          # Configuration et validation env
├── db/              # SQLite + migrations
├── lib/             # Utilitaires (crypto, jwt, cache)
├── middleware/      # Rate limit, auth, errors
└── modules/
    ├── auth/        # Authentification
    ├── letterboxd/  # Client API + service
    └── stremio/     # Manifest Stremio
```
