import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(input: unknown): string | null {
  let digits = String(input ?? "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!url || !publicKey || !serviceKey) return json({ error: "server_configuration_error" }, 500);
  if (!authorization) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(url, publicKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const phone = normalizePhone(payload.phone);
  const password = String(payload.password ?? "");
  const fullName = String(payload.full_name ?? "").trim();
  const vehicleDescription = String(payload.vehicle_description ?? "").trim();
  if (!phone) return json({ error: "invalid_phone" }, 400);
  if (password.length < 8) return json({ error: "weak_password" }, 400);
  if (!fullName) return json({ error: "name_required" }, 400);

  const adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ownerMembership, error: ownerError } = await adminClient
    .from("vertice_members")
    .select("organization_id")
    .eq("user_id", authData.user.id)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (ownerError || !ownerMembership) return json({ error: "forbidden" }, 403);

  const email = `${phone}@sixstar.mobi`;
  const { data: createdUser, error: createUserError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
  });
  if (createUserError || !createdUser.user) {
    const message = createUserError?.message ?? "";
    const alreadyExists = /already|registered|exists/i.test(message);
    return json({ error: alreadyExists ? "phone_already_registered" : "create_user_failed" }, alreadyExists ? 409 : 400);
  }

  const userId = createdUser.user.id;
  const organizationId = ownerMembership.organization_id;
  const { error: memberError } = await adminClient.from("vertice_members").insert({
    organization_id: organizationId,
    user_id: userId,
    role: "driver",
  });
  if (memberError) {
    await adminClient.auth.admin.deleteUser(userId);
    return json({ error: "member_link_failed", detail: memberError.message }, 500);
  }

  const { error: driverError } = await adminClient.from("vertice_drivers").insert({
    organization_id: organizationId,
    user_id: userId,
    display_name: fullName,
    vehicle_description: vehicleDescription || null,
  });
  if (driverError) {
    await adminClient.from("vertice_members").delete()
      .eq("user_id", userId)
      .eq("organization_id", organizationId);
    await adminClient.auth.admin.deleteUser(userId);
    return json({ error: "driver_profile_failed", detail: driverError.message }, 500);
  }

  return json({ user_id: userId, phone, role: "driver" }, 201);
});
