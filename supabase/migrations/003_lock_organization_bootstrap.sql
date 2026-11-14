-- Vértice: impede que qualquer conta autenticada crie uma organização e obtenha papel owner.
-- Execute depois das migrações 001 e 002. O provisionamento inicial deve ser feito por um responsável no SQL Editor.
revoke all on function public.vertice_create_organization(text) from public, anon, authenticated;
