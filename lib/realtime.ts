// Jalur cepat remote via Supabase Realtime Broadcast.
// Channel per kode ruang; event "cmd" (remote->tablet) & "status" (tablet->remote).
// Broadcast bersifat ephemeral (tanpa tabel DB) dan jalan dengan anon key.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CONFIG, hasRealtime } from "@/lib/config";
import type { RemoteCommand, TabletStatus } from "@/lib/remote";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!hasRealtime()) return null;
  if (!client) {
    client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      realtime: { params: { eventsPerSecond: 20 } },
      auth: { persistSession: false },
    });
  }
  return client;
}

export interface RealtimeHandle {
  sendCmd: (cmd: RemoteCommand) => void;
  sendStatus: (status: TabletStatus) => void;
  close: () => void;
}

export function joinChannel(
  room: string,
  handlers: {
    onCmd?: (cmd: RemoteCommand) => void;
    onStatus?: (status: TabletStatus) => void;
    onReady?: (ready: boolean) => void;
  }
): RealtimeHandle | null {
  const c = getClient();
  if (!c) return null;

  const channel = c.channel(`prompter-${room}`, {
    config: { broadcast: { self: false, ack: false } },
  });

  if (handlers.onCmd) {
    channel.on("broadcast", { event: "cmd" }, ({ payload }) =>
      handlers.onCmd?.(payload as RemoteCommand)
    );
  }
  if (handlers.onStatus) {
    channel.on("broadcast", { event: "status" }, ({ payload }) =>
      handlers.onStatus?.(payload as TabletStatus)
    );
  }

  channel.subscribe((status) => {
    handlers.onReady?.(status === "SUBSCRIBED");
  });

  return {
    sendCmd: (cmd) =>
      void channel.send({ type: "broadcast", event: "cmd", payload: cmd }),
    sendStatus: (status) =>
      void channel.send({ type: "broadcast", event: "status", payload: status }),
    close: () => {
      void c.removeChannel(channel);
    },
  };
}
