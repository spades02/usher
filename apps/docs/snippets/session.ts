// Stand-ins for your auth library (Better Auth, Clerk, Auth.js, Supabase, a cookie session...)
// and your data layer, so the other snippets type-check.
export interface Session {
  user: { id: string; name: string; email: string };
}

export async function getSession(_headers: Headers): Promise<Session | null> {
  return null;
}

export interface Order {
  id: string;
  status: "open" | "shipped" | "cancelled";
  total: number;
}

export const orders = {
  async list(_userId: string, _status?: Order["status"]): Promise<Order[]> {
    return [];
  },
  async get(_userId: string, _id: string): Promise<Order | null> {
    return null;
  },
  async cancel(_userId: string, _id: string): Promise<void> {},
};
