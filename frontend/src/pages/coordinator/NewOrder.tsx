import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ArrowRight, CheckCircle, Prohibit } from "@phosphor-icons/react";
import { useCreateOrder, useNewOrderForm, usePlanOrder } from "../../api/queries";
import type { OrderDraft, TruckOption } from "../../api/contract";
import { Button, Card, CardHeader, EmptyState, ErrorNote, Loading, Skeleton } from "../../components/ui";
import { isMocked } from "../../lib/env";
import { useSession } from "../../auth/session";
import { dateTimeTz, duration, inr } from "../../lib/time";

/*
  New order and truck choice. The API works out every candidate truck (share one that is already planned
  for the same customer, or send a separate one), gives the reason for each, and recommends one.
  The coordinator approves; this screen never ranks or judges the options itself.
  A customer uses the same page for their own company: the API offers only idle drivers, and the
  customer picks one (DriverChoice below).
*/
const FIELD = "ct-underline-input";
const LABEL = "grid content-start gap-1 text-meta font-semibold text-ink-2";

/** "2026-11-17T15:00" typed as India time -> "2026-11-17T09:30:00Z". */
export function istInputToIso(value: string): string {
  return new Date(`${value}:00+05:30`).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The next day at 15:00 IST, as the value of a datetime-local input. */
export function defaultPromise(nowIso: string): string {
  const ist = new Date(Date.parse(nowIso) + (24 * 60 + 330) * 60_000);
  return `${ist.toISOString().slice(0, 10)}T15:00`;
}

export function NewOrder() {
  const asCustomer = useSession()?.user.role === "CUSTOMER";
  const form = useNewOrderForm(!isMocked("/orders"));
  const plan = usePlanOrder();
  const create = useCreateOrder();
  const [customerId, setCustomerId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [product, setProduct] = useState("");
  const [quantity, setQuantity] = useState("6");
  const [promise, setPromise] = useState("");
  const [planned, setPlanned] = useState<OrderDraft | null>(null);

  useEffect(() => {
    if (!form.data) return;
    setCustomerId((v) => v || form.data.customers[0]?.id || "");
    setProduct((v) => v || form.data.products[0] || "");
    setPromise((v) => v || defaultPromise(form.data.now));
  }, [form.data]);

  if (isMocked("/orders")) {
    return (
      <Page asCustomer={asCustomer}>
        <EmptyState title="New orders need the API.">Start the backend and set VITE_USE_MOCKS=false to plan an order.</EmptyState>
      </Page>
    );
  }

  if (form.data && form.data.customers.length === 0) {
    return (
      <Page asCustomer={asCustomer}>
        <EmptyState title="No order routes available.">Your existing deliveries are available in My deliveries.</EmptyState>
      </Page>
    );
  }

  const qty = Number(quantity);
  const routes = form.data?.routes?.filter((r) => r.customer_id === customerId) ?? [];
  const selectedRoute = routes.find((r) => r.id === routeId) ?? routes[0];
  const valid = customerId !== "" && product.trim() !== "" && qty > 0 && qty <= 40 && promise !== "";
  const done = create.data;

  /** Any edit makes the listed trucks out of date, so they are cleared until the coordinator checks again. */
  function edited<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPlanned(null);
      plan.reset();
      create.reset();
    };
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || plan.isPending) return;
    const draft: OrderDraft = { customer_id: customerId, ...(selectedRoute && { route_id: selectedRoute.id }),
      product: product.trim(), quantity_t: qty, promised_by: istInputToIso(promise) };
    create.reset();
    plan.mutate(draft, { onSuccess: () => setPlanned(draft) });
  }

  function startAgain() {
    setPlanned(null);
    plan.reset();
    create.reset();
  }

  const customer = form.data?.customers.find((c) => c.id === customerId);

  return (
    <Page asCustomer={asCustomer}>
      {form.isPending ? (
        <Loading label="Loading the order form">
          <Skeleton className="h-56 rounded-lg" />
        </Loading>
      ) : form.error ? (
        <ErrorNote what="the order form" error={form.error} onRetry={() => form.refetch()} />
      ) : done ? (
        <Card aria-labelledby="done-h">
          <CardHeader title="Order created" id="done-h" />
          <div className="space-y-3 p-5">
            <p className="flex items-start gap-2 text-body text-ink">
              <CheckCircle size={20} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-low" />
              <span>
                <span className="font-semibold">{done.order_id}</span>{" "}
                {asCustomer
                  ? `is booked with ${done.option.driver_name} on ${done.option.vehicle_reg}, leaving Plant X ${dateTimeTz(done.option.planned_departure!)}. Plant X and ${done.option.driver_name?.split(" ")[0]} have been told.`
                  : done.option.type === "ADD_TO_TRUCK"
                    ? `travels on ${done.shipment_id} (${done.option.vehicle_reg}) with the order already planned. The customer has been notified.`
                    : `has its own truck, ${done.option.vehicle_reg} (${done.shipment_id}), driven by ${done.option.driver_name}. ${done.option.driver_name?.split(" ")[0]} and the customer have been notified.`}
              </span>
            </p>
            {done.option.km_saved !== null && (
              <p className="text-body text-ink-2">
                One {done.option.km_saved} km trip avoided, about {inr(done.option.cost_saved_inr ?? 0)}.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Link to={`/${asCustomer ? "customer" : "coordinator"}/shipments/${done.shipment_id}`} className="btn-primary ct-go inline-flex h-10 items-center gap-2 rounded-md border border-accent bg-accent px-4 text-body font-semibold text-on-accent hover:bg-accent-hover">
                {asCustomer ? "Follow this delivery" : `Open ${done.shipment_id}`}
                <ArrowRight size={16} weight="bold" aria-hidden />
              </Link>
              <Button onClick={startAgain}>Add another order</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Card aria-labelledby="order-h">
            <CardHeader title="Order" id="order-h" />
            <form onSubmit={onSubmit} className="grid grid-cols-1 gap-x-8 gap-y-6 p-5 sm:grid-cols-2 sm:p-6">
              {asCustomer ? (
                <div className={LABEL}>
                  Deliver to
                  <p className="flex h-12 items-center border-b-2 border-line text-lead font-normal text-ink">{customer?.deliver_to ?? customer?.name}</p>
                </div>
              ) : (
                <label className={LABEL} htmlFor="order-customer">
                  Customer
                  <select id="order-customer" className={FIELD} value={customerId} onChange={(e) => { setRouteId(""); edited(setCustomerId)(e.target.value); }}>
                    {form.data.customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {customer?.deliver_to && <span className="font-normal text-muted">Deliver to {customer.deliver_to}</span>}
                </label>
              )}
              {selectedRoute && <label className={LABEL} htmlFor="order-route">
                Route
                <select id="order-route" className={FIELD} value={selectedRoute.id} onChange={(e) => edited(setRouteId)(e.target.value)}>
                  {routes.map((r) => <option key={r.id} value={r.id}>
                    {r.name} ({r.id}){r.max_gross_t !== null ? ` · ${r.max_gross_t} t gross limit` : ""}
                  </option>)}
                </select>
              </label>}
              <label className={LABEL} htmlFor="order-product">
                Product
                <select id="order-product" className={FIELD} value={product} onChange={(e) => edited(setProduct)(e.target.value)}>
                  {form.data.products.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className={LABEL} htmlFor="order-qty">
                Quantity (tonnes)
                <input id="order-qty" type="number" min={0.5} max={40} step={0.5} required className={FIELD} value={quantity} onChange={(e) => edited(setQuantity)(e.target.value)} />
              </label>
              <label className={LABEL} htmlFor="order-promise">
                Promised delivery (IST)
                <input id="order-promise" type="datetime-local" required className={FIELD} value={promise} onChange={(e) => edited(setPromise)(e.target.value)} />
              </label>
              <div className="sm:col-span-2">
                <Button type="submit" size="lg" variant={planned ? "secondary" : "primary"} disabled={!valid || plan.isPending}>
                  {plan.isPending ? (asCustomer ? "Checking drivers…" : "Checking trucks…") : planned ? "Check again" : asCustomer ? "Show free drivers" : "Find a truck"}
                </Button>
              </div>
            </form>
            {plan.error && (
              <div className="px-5 pb-5">
                <ErrorNote what="the truck options" error={plan.error} onRetry={() => plan.reset()} />
              </div>
            )}
          </Card>

          {planned && plan.data && (
            <Card aria-labelledby="trucks-h">
              <CardHeader title={asCustomer ? "Drivers free now" : "Trucks for this order"} id="trucks-h" />
              {create.error && (
                <div className="px-5 pt-4">
                  <ErrorNote what="the order" error={create.error} onRetry={() => plan.mutate(planned)} />
                </div>
              )}
              {plan.data.recommended_option_id === null && (
                <p className="px-5 pt-4 text-body text-ink-2">
                  {asCustomer
                    ? "No driver is free for this order right now. Try a smaller quantity or a later time, or ask Plant X."
                    : "No truck can take this order as entered. Change the quantity or the promised time and check again."}
                </p>
              )}
              {asCustomer ? (
                <DriverChoice options={plan.data.options} busy={create.isPending} onPick={(o) => create.mutate({ ...planned, option_id: o.id })} />
              ) : (
                <TruckOptions
                  options={plan.data.options}
                  promisedBy={planned.promised_by}
                  busy={create.isPending}
                  onApprove={(o) => create.mutate({ ...planned, option_id: o.id })}
                />
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function Page({ children, asCustomer }: { children: React.ReactNode; asCustomer: boolean }) {
  return (
    <div className={`mx-auto space-y-6 px-4 py-6 sm:px-6 ${asCustomer ? "max-w-3xl" : "max-w-5xl"}`}>
      <div>
        {asCustomer && (
          <Link to="/customer" className="text-meta font-semibold text-accent-ink hover:underline">
            Your deliveries
          </Link>
        )}
        <h1 className="text-figure font-[750] tracking-[-0.025em]">New order</h1>
        <p className="mt-1 max-w-[62ch] text-body text-muted">
          {asCustomer
            ? "Say what you need and by when, then pick one of the drivers who is free now. Plant X and the driver are told at once, and the delivery appears on your list."
            : "If a truck is already planned for the same customer and has room, the order rides with it. Nothing is assigned until you approve a truck."}
        </p>
      </div>
      {children}
    </div>
  );
}

/** Rows as the API returned them, with the recommended one moved to the top. */
export function TruckOptions({ options, promisedBy, busy, onApprove }: { options: TruckOption[]; promisedBy: string; busy?: boolean; onApprove: (o: TruckOption) => void }) {
  const rows = [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
  return (
    <>
      <ul className="divide-y divide-line md:hidden">
        {rows.map((o) => (
          <li key={o.id} className={`border-l-4 px-4 py-4 ${o.recommended ? "border-accent bg-accent-soft" : "border-transparent"}`}>
            {o.recommended && <p className="text-meta font-semibold text-ink">Recommended</p>}
            <p className={`font-semibold ${o.feasible ? "text-ink" : "text-muted"}`}>{o.label}</p>
            {o.transporter_name && <p className="text-meta text-muted">{o.transporter_name}</p>}
            {o.feasible && o.note && <p className="text-meta text-ink-2">{o.note}</p>}
            {o.feasible ? (
              <>
                <dl className="tnum mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-body">
                  <div><dt className="text-meta text-muted">Expected</dt><dd className="font-semibold">{dateTimeTz(o.eta)}</dd></div>
                  <div><dt className="text-meta text-muted">Against promise</dt><dd>{o.margin_min !== null ? `${duration(o.margin_min)} ${o.margin_min >= 0 ? "early" : "late"}` : "—"}</dd></div>
                  <div><dt className="text-meta text-muted">Load after</dt><dd>{o.load_after_t !== null ? `${o.load_after_t} of ${o.capacity_t} t` : "—"}</dd></div>
                  <div><dt className="text-meta text-muted">Trip saved</dt><dd>{o.km_saved !== null ? `${o.km_saved} km, ${inr(o.cost_saved_inr ?? 0)}` : "—"}</dd></div>
                </dl>
                <Button className="mt-3 w-full" variant={o.recommended ? "primary" : "secondary"} disabled={busy} onClick={() => onApprove(o)}>
                  Approve<span className="sr-only">: {o.label}</span>
                </Button>
              </>
            ) : (
              <p className="mt-1 flex items-start gap-1 text-meta text-ink-2">
                <Prohibit size={14} weight="bold" aria-hidden className="mt-0.5 shrink-0" /> Not available: {o.infeasible_reason}
              </p>
            )}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
      <table className="tnum w-full min-w-[820px] text-body">
        <caption className="sr-only">Trucks that could carry this order, promised by {dateTimeTz(promisedBy)}. Recommended first.</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta text-muted">
            <th scope="col" className="px-5 py-2 font-medium">Option</th>
            <th scope="col" className="py-2 pr-4 font-medium">Load after</th>
            <th scope="col" className="py-2 pr-4 font-medium">Leaves</th>
            <th scope="col" className="py-2 pr-4 font-medium">Expected</th>
            <th scope="col" className="py-2 pr-4 font-medium">Against promise</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Trip saved</th>
            <th scope="col" className="py-2 pr-5 font-medium">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className={`border-b border-line last:border-0 ${o.recommended ? "bg-accent-soft" : ""} ${o.feasible ? "" : "text-muted"}`}>
              <th scope="row" className={`px-5 py-3 text-left font-normal ${o.recommended ? "border-l-4 border-accent" : "border-l-4 border-transparent"}`}>
                {o.recommended && <span className="mb-1 block text-meta font-semibold text-ink">Recommended</span>}
                <span className={`block font-medium ${o.feasible ? "text-ink" : "text-muted"}`}>{o.label}</span>
                {o.transporter_name && <span className="block text-meta text-muted">{o.transporter_name}{o.type === "ADD_TO_TRUCK" && o.driver_name ? `, driver ${o.driver_name}` : ""}</span>}
                {o.feasible && o.note && <span className="block text-meta text-ink-2">{o.note}</span>}
                {!o.feasible && (
                  <span className="mt-0.5 inline-flex items-start gap-1 text-meta text-ink-2">
                    <Prohibit size={14} weight="bold" aria-hidden className="mt-0.5 shrink-0" />
                    Not available: {o.infeasible_reason}
                  </span>
                )}
              </th>
              <td className="whitespace-nowrap py-3 pr-4">{o.feasible && o.load_after_t !== null ? `${o.load_after_t} of ${o.capacity_t} t` : "—"}</td>
              <td className="py-3 pr-4">{o.feasible ? dateTimeTz(o.planned_departure) : "—"}</td>
              <td className="py-3 pr-4 font-semibold">{o.feasible ? dateTimeTz(o.eta) : "—"}</td>
              <td className="whitespace-nowrap py-3 pr-4">{o.feasible && o.margin_min !== null ? `${duration(o.margin_min)} ${o.margin_min >= 0 ? "early" : "late"}` : "—"}</td>
              <td className="whitespace-nowrap py-3 pr-4 text-right">{o.feasible && o.km_saved !== null ? `${o.km_saved} km, ${inr(o.cost_saved_inr ?? 0)}` : "—"}</td>
              <td className="py-3 pr-5 text-right">
                {o.feasible ? (
                  <Button variant={o.recommended ? "primary" : "secondary"} size="sm" disabled={busy} onClick={() => onApprove(o)}>
                    Approve<span className="sr-only">: {o.label}</span>
                  </Button>
                ) : (
                  <span className="text-meta">Unavailable</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

/** Customer view: one row per idle driver, with their truck and when it would arrive. */
export function DriverChoice({ options, busy, onPick }: { options: TruckOption[]; busy?: boolean; onPick: (o: TruckOption) => void }) {
  const rows = [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
  return (
    <ul className="divide-y divide-line">
      {rows.map((o) => {
        const first = o.driver_name?.split(" ")[0] ?? "this driver";
        return (
          <li key={o.id} className={`grid grid-cols-1 gap-3 border-l-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${o.recommended ? "border-accent bg-accent-soft" : "border-transparent"}`}>
            <div className="min-w-0">
              {o.recommended && <p className="text-meta font-semibold text-ink">Earliest on time</p>}
              <p className={`text-lead font-semibold ${o.feasible ? "text-ink" : "text-muted"}`}>{o.driver_name}</p>
              <p className="text-meta text-muted">
                {o.transporter_name}
                {o.vehicle_reg ? `, truck ${o.vehicle_reg} (${o.capacity_t} t)` : ""}
              </p>
              {o.feasible ? (
                <p className="tnum mt-1 text-body text-ink-2">
                  Leaves {dateTimeTz(o.planned_departure!)}, expected <span className="font-semibold text-ink">{dateTimeTz(o.eta!)}</span>
                  {o.margin_min !== null && `, ${duration(Math.abs(o.margin_min))} ${o.margin_min >= 0 ? "early" : "late"}`}
                </p>
              ) : (
                <p className="mt-1 flex items-start gap-1 text-meta text-ink-2">
                  <Prohibit size={14} weight="bold" aria-hidden className="mt-0.5 shrink-0" /> {o.infeasible_reason}
                </p>
              )}
            </div>
            {o.feasible && (
              <Button variant={o.recommended ? "primary" : "secondary"} disabled={busy} onClick={() => onPick(o)}>
                Choose {first}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
