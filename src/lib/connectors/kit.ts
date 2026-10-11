// What every adapter in lib/connectors shares (0204, 0205): how it says a
// provider refused or asked us to wait, the rows it hands back, and what
// the worker gives it to write with. Nothing here knows a provider.

/** The provider turned the credential down: the owner must connect again. */
export class ConnectorRefused extends Error {}
/** The provider asked us to slow down: come back later, nothing is wrong. */
export class ConnectorBusy extends Error {}

/** A shipment as courier_shipments keeps it (abo_connector_put_shipments). */
export type ShipmentRow = {
  shipment_ref: string;
  awb: string | null;
  order_ref: string | null;
  courier?: string | null;
  status?: string | null;
  status_at?: string | null;
  ndr_reason?: string | null;
  ndr_attempts?: number | null;
  rto?: boolean;
  shipped_at?: string | null;
  delivered_at?: string | null;
  payment_mode?: string | null;
  cod_amount?: number | null;
  track_url?: string | null;
};

export type Job = {
  secret: string;
  cursors: Record<string, { cursor: string | null; synced_through: string | null }>;
};

export type SyncIO = {
  putShipments(rows: ShipmentRow[]): Promise<void>;
  putCursor(resource: string, cursor: string | null, through?: string | null): Promise<void>;
  putSecret(secret: string): Promise<void>;
  /** Stop starting pages after this (ms since epoch); the next run carries on. */
  deadline: number;
  /** Where this provider posts to us, ending in "/": the hook's token follows it. */
  hookBase: string;
  /** The token a provider's deliveries carry in their address, kept hashed (0205). */
  putHook(token: string): Promise<void>;
  /** This connection's shipments not yet settled that have not moved for hours, oldest first. */
  openShipments(settled: string[], limit: number): Promise<string[]>;
};

export type Fetch = typeof fetch;
