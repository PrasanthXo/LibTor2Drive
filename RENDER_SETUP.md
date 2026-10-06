# LibTor2Drive on Render

## Render service

Create a **Web Service** with:

- Runtime: **Docker**
- Branch: `main`
- Root Directory: leave blank
- Dockerfile Path: `./Dockerfile`
- Instance: **Free**
- Health Check Path: `/health`

Render supplies `PORT` automatically.

## Required environment variables

Set these in Render -> Environment:

```text
ARIA2_RPC_URL=http://127.0.0.1:6800/jsonrpc
ARIA2_RPC_SECRET=<use Render Generate>
ARIA2_DOWNLOAD_DIR=/tmp/downloads
APP_API_KEY=<use Render Generate>

GOOGLE_DRIVE_FOLDER_ID=<destination folder ID>
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
GOOGLE_REFRESH_TOKEN=<Google OAuth refresh token>

DELETE_AFTER_UPLOAD=true
```

Optional, when a separate website calls this API:

```text
CORS_ORIGIN=https://your-frontend.example
```

For multiple allowed origins, separate them with commas.

Do not expose `ARIA2_RPC_SECRET`, `APP_API_KEY`, Google client secrets, or refresh tokens in browser JavaScript or commit them to GitHub.

## Google Drive authentication

The recommended configuration for a personal Google Drive uses an OAuth client ID, client secret, and refresh token.

A service-account JSON credential is also supported with:

```text
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_DRIVE_FOLDER_ID=<folder shared with that service account>
```

Do not set both authentication methods unless you intentionally want OAuth to take precedence.

## API authentication

All `/api/*` routes require:

```http
Authorization: Bearer <APP_API_KEY>
```

`/health` is intentionally public for Render health checks.

## Start a URL or magnet download

```bash
curl -X POST "https://YOUR-SERVICE.onrender.com/api/download" \
  -H "Authorization: Bearer YOUR_APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/file.zip"}'
```

Magnet links use the same route.

## Upload a torrent file

```bash
curl -X POST "https://YOUR-SERVICE.onrender.com/api/torrent" \
  -H "Authorization: Bearer YOUR_APP_API_KEY" \
  -F "torrent=@example.torrent"
```

## Check downloads

```bash
curl "https://YOUR-SERVICE.onrender.com/api/downloads" \
  -H "Authorization: Bearer YOUR_APP_API_KEY"
```

Completed files are uploaded into `GOOGLE_DRIVE_FOLDER_ID`. With `DELETE_AFTER_UPLOAD=true`, local copies are deleted after a successful Drive upload.

## Free Render storage warning

`/tmp/downloads` is ephemeral storage. It can be lost on restart/redeploy and is not a replacement for Google Drive. The service is designed to use it only as temporary download space.
