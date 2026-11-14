import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: unknown) {
  const value = String(raw ?? "").trim();
  const digits = value.replace(/\D/g, "");
  let phone = value.startsWith("+") ? `+${digits}`
    : digits.length === 10 || digits.length === 11 ? `+55${digits}`
    : digits.startsWith("55") && (digits.length === 12 || digits.length === 13) ? `+${digits}`
    : "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Informe um celular válido com DDD.");
  return phone;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Configuração segura do serviço incompleta." }, 500);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sessão necessária." }, 401);

  try {
    const payload = await request.json();
    const organizationId = String(payload.organizationId ?? "");
    const name = String(payload.name ?? "").trim();
    const password = String(payload.password ?? "");
    const role = String(payload.role ?? "driver");
    const vehicle = String(payload.vehicle ?? "").trim();
    const phone = normalizePhone(payload.phone);
    const email = technicalEmail(phone);

    if (!/^[0-9a-f-]{36}$/i.test(organizationId)) throw new Error("Operação inválida.");
    if (name.length < 2 || name.length > 120) throw new Error("Informe o nome completo do usuário.");
    if (password.length < 8 || password.length > 72) throw new Error("A senha inicial precisa ter de 8 a 72 caracteres.");
    if (!['driver', 'dispatcher'].includes(role)) throw new Error("Perfil inválido.");
    if (vehicle.length > 160) throw new Error("Descrição do veículo muito longa.");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json({ error: "Sessão inválida ou expirada." }, 401);

    const { data: membership, error: membershipError } = await userClient
      .from("vertice_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (membershipError || !membership || !["owner", "dispatcher"].includes(membership.role)) {
      return json({ error: "Somente a administração da operação pode cadastrar usuários." }, 403);
    }
    if (role === "dispatcher" && membership.role !== "owner") {
      return json({ error: "Somente o responsável da operação pode cadastrar outro administrador." }, 403);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, organization_id: organizationId, phone },
    });
    if (createError || !created.user) {
      return json({ error: createError?.message ?? "Não foi possível criar a conta." }, 400);
    }

    const { data: profileId, error: profileError } = await userClient.rpc("vertice_onboard_user", {
      target_organization_id: organizationId,
      target_user_id: created.user.id,
      target_role: role,
      display_name: role === "driver" ? name : null,
      vehicle_info: role === "driver" ? vehicle || null : null,
    });
    if (profileError) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      return json({ error: profileError.message }, 400);
    }

    return json({ userId: created.user.id, profileId, phone, role });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Não foi possível cadastrar o usuário." }, 400);
  }
});
