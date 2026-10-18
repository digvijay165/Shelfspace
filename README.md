# Shelfspace

**Live site:** [shelfspace-u4i2.onrender.com](https://shelfspace-u4i2.onrender.com)

> Hosted on Render's free plan: the first visit after a quiet spell can take up to a minute to wake up, and the demo library resets when the service restarts.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/digvijay165/Shelfspace)

Shelfspace is a book library with a dimensional, two-page reader and a public community shelf. It includes account creation and sign-in, per-account book storage, TXT/Markdown imports, selectable cover designs, optional cover art, search, reading progress, and an admin review queue for publishing books.

## Run it

1. Install Node.js 18 or newer if it is not already installed.
2. Open this folder in a terminal.
3. Run `npm start`.
4. Visit [http://127.0.0.1:4173](http://127.0.0.1:4173).
5. Create an account, then add a `.txt` or `.md` book.

## How publishing works

1. A reader uploads a book. It is private and marked **Under review**; only they can read it.
2. Admins see a badge on **Review submissions** in the sidebar. The review page shows an overview (waiting, published, declined, readers), search, word count and reading time for each book, and the full text.
3. The admin either **Approves & publishes** it (it appears on the public Community shelf) or **Declines** it with an optional note.
4. The uploader sees the note on their book card and can fix the book and **Send for review again**.

Admins can also unpublish or delete any book, and promote or demote other accounts from the **Readers** tab. The site owner's account (from `admin-email.txt` / `ADMIN_EMAIL`) always stays an admin.

Admins can download the entire library from **Review submissions → Export all data**, or open `http://127.0.0.1:4173/api/admin/export` while signed in. The JSON export contains book text, cover images, publication status, uploader details, and account names/emails. It does not contain passwords, password hashes, or session tokens. Download the file in your browser, then attach it to a Claude chat; Claude cannot fetch a `127.0.0.1` link directly.

## Admin access

For a local install, create a file named `admin-email.txt` beside `server.js` containing the owner's email; that account receives admin access when it signs up. The file is ignored by git so your email never reaches the repository. Alternatively, create the account first and promote it from this folder:

```powershell
npm run admin:promote -- reader@example.com
```

Sign out and back in to refresh the account role. To grant admin access by email on a hosted install, set `ADMIN_EMAIL` to the owner's email before starting the server. Keep that setting private and assign it only to the site owner's account.

There are no external packages to install. Account and book data are saved in `data.json` beside `server.js`; that file is created the first time an account or book is saved. The server listens on the local computer only (`127.0.0.1`) unless `HOST` is set.

## Deploy

The repository includes a `render.yaml` blueprint for [Render](https://render.com):

1. Click **Deploy to Render** above and sign in with GitHub.
2. When asked for `ADMIN_EMAIL`, enter the email you will sign up with. That account becomes the site owner and admin.
3. Wait for the deploy to finish, open the `onrender.com` link, and create your account with that email.

The blueprint sets `HOST=0.0.0.0` (listen publicly) and `TRUST_PROXY=1` (secure cookies behind Render's HTTPS). Health checks use `/healthz`.

**Storage on the free plan:** books and accounts live in `data.json` on the server's disk. Render's free plan wipes that disk whenever the service restarts or redeploys, and sleeps after 15 minutes idle. For a library that lasts, add a Render persistent disk (paid) mounted at e.g. `/var/data` and set `DATA_FILE=/var/data/data.json`.

## Notes

- **3D reader:** the book's cover swings open, pages turn as real 3D leaves with shading, the page edges thicken on the side you have read, and the book leans gently toward your mouse. Motion is skipped if your system asks for reduced motion.
- **Book formatting:** lines like `Chapter 1`, `Part Two`, `Prologue`, or Markdown `#`/`##` headings become chapters. Each starts a new page with a heading and drop cap, and they are listed under **☰ Contents**. Markdown bold, quotes, and `---` rules are tidied up.
- **Sound:** page turns, opening, and closing play soft paper sounds (made in the browser, no audio files). **♪** turns them on or off; **☂** plays a gentle rain ambience while you read.
- **Turning pages:** click a page, swipe on touch screens, use ← → / Page Up / Page Down, or Home / End. Pages are sized to fit your screen and re-flow when the window is resized. **Aa** cycles small, medium, and large text. The top line shows the estimated reading time left.
- Press Ctrl K (⌘ K on a Mac) to jump to library search.
- To try the app without touching your real library, start it with a separate data file, e.g. `DATA_FILE=./test-data.json PORT=4180 npm start`.
- Pick one of six cover styles or upload a PNG, JPG, WebP, or GIF cover image smaller than 1 MB.
- Text files can be up to 2 MB. Images and book text are stored in the local JSON data file.
- This starter app keeps sessions in memory, so signing in again is needed after restarting the server.
- The Google Fonts link is optional; the interface falls back to system serif and sans-serif fonts when offline.
