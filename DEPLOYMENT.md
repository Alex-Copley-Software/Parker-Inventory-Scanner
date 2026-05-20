# Parker Inventory Scanner Deployment

This app can run in two modes:

- Local: `npm start`, then open `http://localhost:3000`.
- Cloud: Netlify hosts the static frontend, Railway hosts the Express API and SQLite database.

## Railway Backend

1. Create a new Railway project from this GitHub repository.
2. Set the start command to:

   ```bash
   npm start
   ```

3. Add a Railway volume for the SQLite database.
4. Mount the volume at `/data`.
5. Add these Railway environment variables:

   ```text
   DATA_DIR=/data
   CORS_ORIGIN=https://YOUR-NETLIFY-SITE.netlify.app
   ```

   During first testing, `CORS_ORIGIN` can be left unset. The server allows all origins when it is unset.

6. After deploy, copy the Railway public URL, such as:

   ```text
   https://parker-inventory-scanner-production.up.railway.app
   ```

## Netlify Frontend

1. Create a new Netlify project from this GitHub repository.
2. Use these build settings:

   ```text
   Build command: empty
   Publish directory: public
   ```

3. Open the Netlify site.
4. Paste the Railway backend URL into the `Backend URL` field in the Count Session panel and click `Save backend URL`.

You can also open the Netlify site once with the backend URL in the query string:

```text
https://YOUR-NETLIFY-SITE.netlify.app/?api=https://YOUR-RAILWAY-BACKEND.up.railway.app
```

The app stores that URL in browser local storage. The phone scanner QR also includes it, so the phone will talk to the Railway backend automatically.

## Tags

Tags are global and always use this format:

```text
W-001
W-002
W-003
```

They are not category-specific.
