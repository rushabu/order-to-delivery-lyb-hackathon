# Order-to-Delivery Control Tower

LYB Mumbai Hackathon 2026, Round 2, Problem Statement 3. Tracks bulk polymer shipments from plant to customer, predicts delays with an explainable rules engine, suggests actions for a coordinator to approve, and gives the coordinator, driver and customer one shared view.

Plant X, the orders, and the fleet are fictional. Live routing uses real routes, traffic, and weather for the fictional shipments.

## Repository layout

| Folder | Contents |
|---|---|
| [`frontend/`](frontend/) | React + Vite web app for all three roles, with an in-browser mock API. See [frontend/README.md](frontend/README.md) |
| [`backend/`](backend/) | API service (Node, TypeScript, Fastify), and the canonical [DESIGN.md](backend/DESIGN.md), [PHASES.md](backend/PHASES.md) and [AI_USAGE.md](backend/AI_USAGE.md) |
| [`database/`](database/) | Database schema, migrations and fictional seed data |

## Choose a demo

| Mode | Configuration | What you can show |
|---|---|---|
| Live routing | Root launcher and a TomTom key | Fictional shipments with real routes, traffic-aware ETA, traffic flow, reported incidents, and Open-Meteo weather. |
| Scripted replay | Root launcher with `SEED_SAMPLE_ORDERS=true` in `backend/.env` | Repeatable delay and reroute walkthrough with the seeded shipment data. |
| Browser-only mock | `VITE_USE_MOCKS=true` | Scripted walkthrough with demo sign-in buttons and local browser data. |

## Run the full app

Use Node.js **24.15 or later**. Open a terminal in the inner `LYBHackathon` folder that contains `backend` and `frontend`. Run setup on a fresh checkout or after a dependency update.

```powershell
npm run setup
```

For live routing and road conditions, set `TOMTOM_API_KEY` in `backend/.env`. Keep the existing file if you already configured the key. A new file only needs the key for a local demo.

```powershell
npm run dev
```

Open [the web app](http://127.0.0.1:5173). The launcher starts both services and Ctrl+C stops them. By default it uses an in-memory database with accounts, fleet, and routes and an empty order list. Use **New order** to select a customer, choose a route, and assign a driver. Sign in as that driver and click **Leave the plant** to record dispatch and departure, update tracking, and notify the customer and coordinator. Existing file databases are preserved. Restart the launcher after editing backend code or `backend/.env`. On Windows x64, setup verifies the bundled SQLite binding.

Stop any separate API or web servers already using the ports before starting. The defaults are API 4000 and web 5173. Override them with `PORT` and `WEB_PORT` in your shell when needed.

## Demo accounts

Use the email and password from [`database/seed/users.json`](database/seed/users.json) for the named account. Open separate browser profiles or independent windows for the roles. In demo mode (the launcher default) the sign-in page also lists every account under **Quick sign-in**; one click signs in without a password.

| Role | Account |
|---|---|
| Coordinator | Meera Kulkarni |
| Ranjangaon customer (Talegaon–Chakan or Pune–Shikrapur) | Anil Deshpande or Kavita Joshi |
| Satpur customer (Kasara Ghat or Wada–Trimbakeshwar) | Nikhil Bhosale |
| Vikhroli live demo customer | Asha Rao |
| Powai live demo customer | Rohan Shah |
| Chakan live demo customer | Neha Patil |
| Live driver | The driver listed beside each shipment in Demo controls |

## Run a live shipment

1. Sign in as the coordinator and open **Demo controls → Live routing demo**.
2. Choose **Kandivali → Vikhroli** or **Goregaon → Powai** for a Mumbai delivery-van demo. For a generated shipment, choose **Mumbai** or **Regional** under **Generator area**, leave **Seed** blank, and click **Generate shipment**. Reuse the same area and seed to reproduce the shipment inputs. Live traffic and ETA depend on when you run it.
3. Review the preview and click **Start live shipment**. Open the trip from the list. Start another preset or generated shipment to see more lanes on the **Attention** map. The demo assigns a separate driver to each live shipment and can run three at a time.
4. On shipment detail, show **driving time remaining** and **delivery ETA**. Driving time comes from TomTom and includes traffic. The delivery ETA also includes the planned stop. **Refresh traffic** requests an update, and the backend also refreshes roughly once a minute. If a usable alternative is returned and the shipment is at risk, the coordinator can review options and approve it while the exit is still reachable.
5. On the coordinator or customer shipment map, or the driver's trip brief, open **Traffic flow and incidents**. The colored segments compare current speed with free-flow speed. Incident markers and the list show current reports near the next 20 km of the trip, including closures and roadworks when available. Traffic is sampled at up to three points and refreshes every two minutes while the map is open.
6. Sign in as the assigned driver or the listed customer to see their views. The simulated vehicle moves at **1×**, at the average pace implied by the latest driving estimate. Its planned unloading time also runs at 1×. Use the scripted replay to show the complete lifecycle quickly. **Reset to 08:50** clears the live trips and restores the scripted seed.

### Ask the assistant

Every role has a chat button in the top bar. It answers questions such as "Where is my order?" or "Which shipments are at risk?" from the shipments that person may see, using a language model from Groq. Set `GROQ_API_KEY` in `backend/.env` (free key from console.groq.com/keys) and restart; without the key the panel says the assistant is switched off. Details and limits are in [AI_USAGE.md](backend/AI_USAGE.md#run-time-ai-in-the-product).

### Add an order and choose its truck

A customer can order too: on **Your deliveries**, click **New order**, enter product, quantity and time, then **Show free drivers** and **Choose** one. Customers only order for their own company and only see idle drivers; sharing a planned truck stays the coordinator's call. The coordinators get a notification, the driver gets the new trip, and the order appears on the customer's list, all live.

Sign in as the coordinator and open **New order**. Pick the customer, product, quantity and promised time, then **Find a truck**. The app lists every candidate with its reason and marks one **Recommended**; nothing is assigned until you click **Approve**.

An order can share a truck that is already planned when all of these hold:

1. the truck has not left the plant;
2. it is going to the same customer;
3. it has enough spare payload;
4. the new order is not promised earlier than the truck's own promise;
5. the truck's current ETA is at or before the new order's promise.

Otherwise the order gets its own truck. Only idle drivers are offered (no trip planned or under way), each with the smallest free truck of their transporter that can carry the load. The truck is planned to arrive an hour before the promise and to leave no sooner than an hour from now. The seed has three idle drivers for this: Prakash Jadhav, Imran Shaikh and Deepak More; Ravi, Gurpreet and Sunil drive the scripted trips and the live-routing demo.

To see it after **Reset to 08:50**: 6 t for Deccan Mouldings, promised the next day at 15:00, is recommended onto SHP-1004 (a 28 t truck carrying 20 t). That avoids a 150 km trip, about ₹6,750 at the seed's ₹45 per km. SHP-1001 is listed as unavailable because it has already left. Ask for 9 t and the shared truck is refused ("Only 8 t spare") in favour of a separate one.

After approval, without a page reload:

- the customer sees the order on **Your deliveries** and gets a notification;
- the driver gets a **New trip** banner and notification; the trip shows the route map, alerts on the route, and safety points for its load and timing (a driver with several trips switches between them at the top);
- a shared truck shows **Also on this truck**, and its driver is told to load the extra order.

A generated invoice has one line per order, and the reset removes the new orders. Not covered: orders for different delivery points on one truck, trucks already on the road, and the customer's receiving hours.

### Upload and download an invoice

On a shipment's page the coordinator has an **Invoice** card with two ways to add one:

- **Generate invoice** builds a one-page PDF from the shipment itself: customer, order, product, quantity, vehicle and dates, priced at a fictional rate per tonne plus GST. The rates are in [`database/seed/config.json`](database/seed/config.json) under `invoice` and explained in the [database README](database/README.md#generated-invoices).
- **Upload PDF** takes your own file (PDF only, up to 2 MB). Ready-made samples for the five demo shipments are in [`database/samples/invoices/`](database/samples/invoices/).

Either one replaces the invoice already there. The customer is notified, and the same card on their delivery page has a **Download** button. Drivers never see invoices. The file is stored in the database, so **Reset to 08:50** removes it.

### Driver checks, stops and the delivery photo

1. Sign in as a driver. Before the trip screen, the driver passes two checks, valid for 12 hours:
   - **Licence scan**: hold a driving licence to the camera, or choose a photo. The text is read in the browser (Tesseract.js) and must say "driving licence" plus a licence number or the usual card fields. The image and text are discarded at once; the server stores only that the check passed and when. The first scan downloads the reader's language data (about 10 MB).
   - **Voice check**: read the random phrase aloud. Chrome and Edge must hear both random words; other browsers accept a live voice. Nothing is recorded. Needs a microphone.
2. On the road the driver sees driving time since the last break (break due after 5 hours; a placeholder rule) and can mark a **Rest break**, **Fuel**, **Charging** or **Other** stop. The coordinator is notified. If the truck stays still for 10 minutes away from a planned checkpoint, the app records an unplanned stop and alerts the coordinator.
3. On a shipment page the coordinator's **Driver** card shows the driver's phone and live status. **Call** opens the phone dialler; **Ask to check in** sends a request the driver answers with "I'm all right" or "I have a problem".
4. On arrival the driver must send a **delivery photo** before marking the shipment delivered. The coordinator clicks **Verify delivery**; the customer sees the photo with "Confirmed by Plant X".
5. The coordinator's **Trip log** lists status changes, reports, stops, check-ins, the photo, the invoice, alerts and decisions, newest first. The customer's delivery page shows time and km to go, early or late, and why.

**Reset to 08:50** clears checks, stops, check-ins and photos.

### Seeded routes and new orders

For seeded routes and shipments created through **New order**, TomTom also refreshes the active corridor roughly every five minutes. The coordinator can refresh manually from shipment detail. For moving trucks, the refresh also quotes configured bypasses that are still reachable and within the truck's restrictions. Simplified seed routes use a waypoint-based quote when TomTom cannot reconstruct the stored geometry.

### Preview an electric van

With a Mumbai shipment selected, expand **Preview electric van** and click **Check EV route**. Try 60% starting charge, then 25% to show how a lower charge can add a stop. TomTom estimates the route energy, arrival charge, and any charging stops for a fictional 40 kWh van and a 20% arrival reserve. The estimate includes the shipment's unloading time. This is a pre-dispatch planning check. **Start live shipment** starts the standard tracking demo.

### Preset shipments

| Lane | Cargo | Truck | Gross weight | Planned stop | Promise buffer |
|---|---|---|---|---|---|
| Kandivali → Vikhroli | 600 kg PP sample cartons | Delivery van | 2.7 t | 7 min | 10 min |
| Goregaon → Powai | 800 kg HDPE sample cartons | Delivery van | 2.9 t | 5 min | 10 min |
| Panvel → Ranjangaon | 24 t PP pellets | Rigid truck | 34 t | 15 min | 5 min |
| Panvel → Satpur, Nashik | 28 t HDPE pellets | Tractor-trailer | 40 t | 20 min | 15 min |
| Panvel → Chakan | 8 t LDPE resin | Light rigid | 15 t | 10 min | 25 min |

The generator uses the five demo lanes and selects a delivery van for Mumbai loads. Gross weight is cargo plus tare and stays within the vehicle’s configured capacity. TomTom receives the resulting gross weight and vehicle dimensions. The delivery promise uses the initial free-flow travel time, the planned stop, and the promise buffer. Simulated trips stay out of the historical performance dashboard.

## Rehearse the scripted flow

To rehearse the sample replay, set `SEED_SAMPLE_ORDERS=true` and `DATABASE_FILE=:memory:` in `backend/.env` and restart. On **Demo controls**, select **Reset to 08:50**, then **Start replay**. See the [scripted demo guide](frontend/README.md#three-window-demo-on-one-laptop) for the walkthrough. To return to an empty order list, remove `SEED_SAMPLE_ORDERS` and restart. Previewing generated shipments requires the backend. Starting them also requires TomTom access.

## Troubleshooting

| Symptom | Check |
|---|---|
| Demo controls are missing | `VITE_DEMO_MODE=true` and signed in as a coordinator. |
| Only the scripted replay is available | `VITE_USE_MOCKS=false`, API health is reachable, and frontend has been restarted. |
| Start button asks for a key | `TOMTOM_API_KEY` is in `backend/.env`, with a restarted backend. |
| The live ETA has low confidence | Try **Refresh traffic**. The ETA uses estimated driving time while live routing is unavailable. |
| Road conditions are unavailable | Check TomTom Traffic API access for the key. The map labels the speed and incident feeds separately so a successful feed can still display. |
| The assistant is switched off | `GROQ_API_KEY` is in `backend/.env`, with a restarted backend. |
| No driver available | Wait for a live delivery or reset the demo. |

Run `npm test` inside `backend/` and `frontend/` for the application tests. Run `npm run build` inside `frontend/` for the production build, using the desired frontend environment settings.

## Generative AI

AI coding agents were used for the design documents and the code. See [backend/AI_USAGE.md](backend/AI_USAGE.md).
