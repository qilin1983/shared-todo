# Shared To-Do

To-do lists with free-form notes, photos, deadlines and reminders. Each list is private
until you share it, and you choose exactly which users can see it (view only or can edit).
Works in desktop browsers and on phones (it can be added to the home screen as an app).

## Run it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```sh
npm install
npm start
```

Open http://localhost:3000. The console also prints `http://<your-ip>:3000` addresses:
phones on the same Wi-Fi can use those (allow Node through Windows Firewall if prompted).

Data (SQLite database, uploaded photos, push keys) lives in `./data`.

## Features

- Accounts with username + password (scrypt hashed, HTTP-only session cookie, login throttling)
- Multiple lists; items hold multi-line text and up to 10 photos each (camera, gallery, paste or drag-drop)
- Share a list with selected users as **Can edit** or **View only**; revoke at any time
- **Dashboard** (home screen): overdue / due today / next 7 days / open counts, and tabs for
  All, My lists, Shared with me, Assigned to me, Created by me — tick items off right there
- **Repeating to-dos**: daily, weekdays, weekly, monthly, yearly. Ticking one off rolls it to
  the next date (in the creator's time zone; "31st monthly" becomes the 30th/28th in short months)
- **Assign** a to-do to anyone on the list; they get notified, and its reminder goes only to them
- **Live updates**: changes by other people appear instantly (Server-Sent Events)
- **Comments** on any to-do (view-only members can comment too); people involved get notified
- **Activity history** per list ("🕘 History") and a recent-activity feed on the dashboard
- **Priority** (Low / Medium / High) and **labels** (#tags), with filters on lists and the dashboard
- **Search** across all your lists: to-do text, labels, sub-tasks and comments
- **Sub-tasks** (checklists inside a to-do) and **drag-to-reorder** (Sort → "My order"; works on touch screens)
- **Profiles**: display name, profile picture, change password (signs out your other devices)
- **Export** a list to CSV (opens in Excel/Sheets) or PDF (print view → "Save as PDF")
- Deadline per item, with overdue / due-soon highlighting and overdue counts per list
- Reminders (at deadline, 15 min / 1 h / 1 day / 1 week before, or a custom time):
  - in-app reminder banner with Open / Snooze 1h / Done / Dismiss
  - system notifications, including when the app is closed (Web Push)

## Project layout

```
server.js            Express API, SQLite schema/migrations, reminders job, Web Push, live events
public/index.html    App shell
public/js/           Front-end ES modules (no build step)
  app.js             entry: sign-in and start-up
  core.js            helpers, state, people directory (names/avatars)
  nav.js             sidebar + navigation between dashboard / list / search
  list.js            list view: add form, to-dos, sub-tasks, comments, drag-to-reorder
  dashboard.js       home screen      history.js   activity feed + dialog
  search.js          search           sharing.js   share dialog
  profile.js         profile dialog   reminders.js reminders + push
  fields.js          shared form fields and chips
  live.js            live updates     print.js     printable / PDF view
public/sw.js         service worker for push notifications
```

## Notifications & HTTPS

Browsers only allow push notifications on `https://` or `http://localhost`. Over plain
`http://192.168.x.x` on a phone, reminders still appear inside the app, but not as phone
notifications. To get phone notifications, serve the app over HTTPS (reverse proxy, or a
tunnel such as `cloudflared tunnel --url http://localhost:3000`) and set `COOKIE_SECURE=1`.
On iPhone, notifications work only after "Add to Home Screen" (iOS 16.4+).

## Configuration

| Env var         | Default               | Purpose                                         |
|-----------------|-----------------------|-------------------------------------------------|
| `PORT`          | `3000`                | HTTP port                                       |
| `HOST`          | `0.0.0.0`             | Bind address (`127.0.0.1` = this PC only)       |
| `DATA_DIR`      | `./data`              | Database + uploads location                     |
| `COOKIE_SECURE` | off                   | Set `1` when served over HTTPS                  |
| `TRUST_PROXY`   | off                   | Set `1` when behind a reverse proxy             |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for push services (set a real one) |
