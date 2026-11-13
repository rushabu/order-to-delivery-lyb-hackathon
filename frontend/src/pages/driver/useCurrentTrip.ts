import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useShipment, useShipments } from "../../api/queries";
import { getOutbox, onOutboxSent, useOutbox } from "../../api/outbox";

/** The trip chosen in the URL (?trip=), else the moving or arrived trip ahead of future assignments. */
export function useCurrentTrip() {
  const list = useShipments();
  const [params] = useSearchParams();
  const chosen = list.data?.find((s) => s.id === params.get("trip"));
  const moving = list.data?.filter((s) => s.status === "IN_TRANSIT" || s.status === "ARRIVED");
  const current = chosen ?? moving?.find((s) => s.live_demo) ?? moving?.[0]
    ?? list.data?.find((s) => s.status === "PLANNED" || s.status === "DISPATCHED");
  const currentId = current?.id;
  const detail = useShipment(currentId);
  return { list, detail, currentId };
}

/** The outbox plus a refetch of the trip whenever one of its events is accepted. */
export function useDriverOutbox() {
  const qc = useQueryClient();
  const outbox = getOutbox();
  const state = useOutbox(outbox);
  useEffect(
    () =>
      onOutboxSent((item) => {
        qc.invalidateQueries({ queryKey: ["shipment", item.shipment_id] });
        qc.invalidateQueries({ queryKey: ["shipments"] });
        qc.invalidateQueries({ queryKey: ["eta-history", item.shipment_id] });
      }),
    [qc],
  );
  return { outbox, ...state };
}
