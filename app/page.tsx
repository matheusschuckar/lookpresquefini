"use client";

import Link from "next/link";
// import Image from "next/image"; // descomentaria se for usar <Image />
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import BottomNav from "../components/BottomNav";
import { getPrefs, bumpCategory, bumpStore } from "@/lib/prefs";
import { getViewsMap } from "@/lib/metrics";

// ruído determinístico por produto + seed da sessão
function noiseFor(id: number, seed: number) {
  let x = (id ^ seed) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5; // xorshift32
  return (x >>> 0) / 4294967295; // 0..1
}

type Product = {
  id: number;
  name: string;
  store_name: string;
  photo_url: string;
  eta_text: string | null;
  price_tag: number;
  category?: string | null;
  gender?: "male" | "female" | null;
  sizes?: string | string[] | null;
  view_count?: number;
};

type Profile = {
  id: string;
  name: string | null;
  whatsapp: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  city: string | null;
  state?: string | null;
  cep: string | null;
  status: "waitlist" | "approved";
};

// helpers
function isSPCity(city: string | null | undefined) {
  const c = (city || "").toLowerCase();
  return c.includes("são paulo") || c.includes("sao paulo");
}
function cepOk(cep: string | null | undefined) {
  return (cep || "").replace(/\D/g, "").length === 8;
}
function hasAddressBasics(p: Profile | null) {
  if (!p) return false;
  return !!(p.street && p.number && cepOk(p.cep));
}
function hasContact(p: Profile | null) {
  if (!p) return false;
  return !!(p.name && p.whatsapp);
}
function inCoverage(p: Profile | null) {
  if (!p) return false;
  const cityOk = isSPCity(p.city);
  const stateOk = (p.state || "").toUpperCase() === "SP";
  return cityOk && stateOk;
}
function profileComplete(p: Profile | null) {
  if (!p) return false;
  return hasAddressBasics(p) && hasContact(p) && inCoverage(p);
}
function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
function intersects<T>(a: Set<T>, arr: T[]): boolean {
  for (const x of arr) if (a.has(x)) return true;
  return false;
}
function formatBRL(v: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

export default function Home() {
  const router = useRouter();
  const [rankSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, number>>({}); // mapa de views locais

  // carrega views do localStorage e observa mudanças entre abas
  useEffect(() => {
    setViews(getViewsMap());
    function onStorage(e: StorageEvent) {
      if (e.key === "look.metrics.v1.views" && e.newValue) {
        try {
          setViews(JSON.parse(e.newValue));
        } catch {}
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const [query, setQuery] = useState("");

  // Drawer lateral
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Bloqueia scroll quando drawer ou modal estiverem abertos
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => {
    const anyOverlay = drawerOpen || filterOpen;
    const prev = document.documentElement.style.overflow;
    if (anyOverlay) document.documentElement.style.overflow = "hidden";
    else document.documentElement.style.overflow = prev || "";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [drawerOpen, filterOpen]);

  // Banners
  const banners = useMemo(
    () => [
      {
        title: "Office Looks",
        subtitle: "Pronto para o escritório",
        image:
          "https://images.unsplash.com/photo-1592389902607-0c1e1d1373de?auto=format&fit=crop&w=1200&q=80",
        href: "/collections/work",
      },
      {
        title: "Night out",
        subtitle: "A noite paulistana em grande estilo",
        image:
          "https://images.unsplash.com/photo-1699109216399-7857ed548130?auto=format&fit=crop&w=1200&q=80",
        href: "/collections/night",
      },
      {
        title: "Sunday brunch",
        subtitle: "Nossa seleção para o almoço",
        image:
          "https://images.unsplash.com/photo-1612791096690-137536c85169?auto=format&fit=crop&w=1200&q=80",
        href: "/collections/brunch",
      },
    ],
    []
  );
  const [currentBanner, setCurrentBanner] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setCurrentBanner((p) => (p + 1) % banners.length),
      5000
    );
    return () => clearInterval(id);
  }, [banners.length]);

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.changedTouches[0].clientX;
    touchEndX.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.changedTouches[0].clientX;
  };
  const onTouchEnd = () => {
    if (touchStartX.current === null || touchEndX.current === null) return;
    const delta = touchEndX.current - touchStartX.current;
    const threshold = 40;
    if (delta > threshold) {
      setCurrentBanner((p) => (p - 1 + banners.length) % banners.length);
    } else if (delta < -threshold) {
      setCurrentBanner((p) => (p + 1) % banners.length);
    }
    touchStartX.current = null;
    touchEndX.current = null;
  };

  // ===========================
  // Auth + Data unified (catálogo para todos, sem redirecionar guest)
  // ===========================
  useEffect(() => {
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();

        if (!u.user) {
          // Visitante: catálogo público
          const { data, error } = await supabase
            .from("products")
            .select(
              "id,name,store_name,photo_url,eta_text,price_tag,category,gender,sizes,view_count"
            )
            .eq("is_active", true)
            .limit(60);
          if (error) throw error;
          setProducts((data || []) as Product[]);
          setProfile(null);
        } else {
          // Logado: perfil + mesmo catálogo
          let profResp = await supabase
            .from("user_profiles")
            .select(
              "id,name,whatsapp,street,number,complement,city,state,cep,status"
            )
            .eq("id", u.user.id)
            .single();

          if (profResp.error && /state/i.test(String(profResp.error.message))) {
            profResp = await supabase
              .from("user_profiles")
              .select(
                "id,name,whatsapp,street,number,complement,city,cep,status"
              )
              .eq("id", u.user.id)
              .single();
            if (profResp.data) (profResp.data as any).state = null;
          }
          if (profResp.error) throw profResp.error;

          const prof = profResp.data as Profile;
          setProfile(prof);

          const { data, error } = await supabase
            .from("products")
            .select(
              "id,name,store_name,photo_url,eta_text,price_tag,category,gender,sizes,view_count"
            )
            .eq("is_active", true)
            .limit(60);
          if (error) throw error;
          setProducts((data || []) as Product[]);
        }
      } catch (e: any) {
        const msg = String(e?.message || "");
        console.error("[Home] load error:", msg);
        setErr(msg || "Erro inesperado");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Filtros
  const chipCategories = [
    "Tudo",
    "camiseta",
    "camisa",
    "vestido",
    "saia",
    "calça",
    "sapato",
    "bolsa",
    "jaqueta",
  ];
  const allCategories = chipCategories.filter((c) => c !== "Tudo");
  const [chipCategory, setChipCategory] = useState<string>("Tudo");

  const [activeTab, setActiveTab] = useState<
    "genero" | "tamanho" | "categorias"
  >("genero");

  const [selectedGenders, setSelectedGenders] = useState<
    Set<"male" | "female">
  >(new Set());
  const [selectedSizes, setSelectedSizes] = useState<
    Set<"PP" | "P" | "M" | "G" | "GG">
  >(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set()
  );

  const sizesList: Array<"PP" | "P" | "M" | "G" | "GG"> = [
    "PP",
    "P",
    "M",
    "G",
    "GG",
  ];

  const clearFilters = () => {
    setSelectedGenders(new Set());
    setSelectedSizes(new Set());
    setSelectedCategories(new Set());
    setChipCategory("Tudo");
  };

  const anyActiveFilter =
    selectedGenders.size > 0 ||
    selectedSizes.size > 0 ||
    selectedCategories.size > 0 ||
    chipCategory !== "Tudo";

  // --- filtered ---
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return products.filter((p) => {
      // texto
      if (q) {
        const matchText =
          p.name.toLowerCase().includes(q) ||
          p.store_name.toLowerCase().includes(q) ||
          (p.category || "").toLowerCase().includes(q);
        if (!matchText) return false;
      }

      // categorias (modal > chip)
      if (selectedCategories.size > 0) {
        const pc = (p.category || "").toLowerCase();
        if (!pc || !selectedCategories.has(pc)) return false;
      } else if (chipCategory !== "Tudo") {
        const pc = (p.category || "").toLowerCase();
        if (pc !== chipCategory.toLowerCase()) return false;
      }

      // gênero
      if (selectedGenders.size > 0) {
        const pg = (p.gender || "").toLowerCase();
        if (!pg || !selectedGenders.has(pg as "male" | "female")) return false;
      }

      // tamanho
      if (selectedSizes.size > 0) {
        const raw = Array.isArray(p.sizes)
          ? (p.sizes as string[]).join(",")
          : p.sizes ?? "";
        const list = String(raw)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean) as Array<"PP" | "P" | "M" | "G" | "GG">;

        if (!list.length || !intersects(selectedSizes, list)) return false;
      }

      return true;
    });
  }, [
    products,
    query,
    chipCategory,
    selectedCategories,
    selectedGenders,
    selectedSizes,
  ]);

  // ranking por interesse
  const W_CAT = 0.9;
  const W_STORE = 0.6;
  const JITTER = 0.2;

  const filteredRanked = useMemo<Product[]>(() => {
    const prefs = getPrefs(); // { cat: {...}, store: {...} }

    const catVals = Object.values(prefs.cat);
    const storeVals = Object.values(prefs.store);
    const maxCat = catVals.length ? Math.max(1, ...catVals) : 1;
    const maxStore = storeVals.length ? Math.max(1, ...storeVals) : 1;

    return filtered
      .map((p: Product) => {
        const catKey = (p.category || "").toLowerCase();
        const storeKey = (p.store_name || "").toLowerCase();

        const catScore = (prefs.cat[catKey] || 0) / maxCat; // 0..1
        const storeScore = (prefs.store[storeKey] || 0) / maxStore; // 0..1
        const noise = noiseFor(p.id, rankSeed) * JITTER;

        const score = W_CAT * catScore + W_STORE * storeScore + noise;
        return { p, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }, [filtered, rankSeed]);

  const locationLabel = profile?.city
    ? `${profile.city}${profile?.state ? `, ${profile.state}` : ""}`
    : "São Paulo, SP";

  async function handleLogout() {
    try {
      // fecha o drawer imediatamente
      setDrawerOpen(false);
      await supabase.auth.signOut();

      // zera o profile para o header trocar para “Login” imediatamente
      setProfile(null);
    } finally {
      router.replace("/");
    }
  }

  // Render
  return (
    <main className="bg-white text-black max-w-md mx-auto min-h-screen px-5 pb-10">
      {/* Header */}
      <div className="pt-6 flex items-start justify-between">
        <div>
          <h1 className="text-[32px] leading-8 font-bold tracking-tight">
            Look
          </h1>
          <p className="mt-1 text-[13px] text-gray-600">
            Ready to wear in minutes
          </p>
        </div>

        {/* Menu ou Login */}
        {!loading && !profile ? (
          <Link
            href="/auth"
            className="mt-1 inline-flex items-center rounded-full border border-gray-200 bg-white px-3 h-9 text-sm font-medium hover:bg-gray-50 transition"
            aria-label="Login"
            title="Login"
          >
            Login
          </Link>
        ) : (
          <button
            onClick={() => setDrawerOpen(true)}
            className="mt-1 inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white hover:bg-gray-50 transition"
            aria-label="Menu"
            title="Menu"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              className="text-gray-700"
            >
              <path
                strokeWidth="2"
                strokeLinecap="round"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute right-0 top-0 bottom-0 w-72 bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 h-14 border-b">
              <span className="font-semibold">Menu</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-gray-100"
                aria-label="Fechar"
                title="Fechar"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 px-4 py-4 text-sm">
              <ul className="space-y-3">
                <li>
                  <Link href="/profile" onClick={() => setDrawerOpen(false)}>
                    Perfil
                  </Link>
                </li>
                <li>
                  <Link href="/orders" onClick={() => setDrawerOpen(false)}>
                    Pedidos
                  </Link>
                </li>
                <li>
                  <a
                    href="https://wa.me/5511966111233"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setDrawerOpen(false)}
                  >
                    Suporte
                  </a>
                </li>
              </ul>
            </nav>
            <div className="border-t p-4">
              <button
                onClick={handleLogout}
                className="w-full text-left text-red-600 hover:underline"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cards de orientação — apenas para logado */}
      {profile && !hasAddressBasics(profile) && (
        <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-neutral-900">
          <div className="text-sm font-medium">Complete seu endereço</div>
          <p className="mt-1 text-xs text-neutral-700 leading-5">
            Precisamos do CEP, rua e número para mostrar as opções da sua
            região.
          </p>
          <div className="mt-3">
            <Link
              href="/address"
              className="inline-flex items-center justify-center rounded-lg bg-black px-3 py-2 text-xs font-semibold text-white"
            >
              Atualizar endereço
            </Link>
          </div>
        </div>
      )}

      {profile && hasAddressBasics(profile) && !hasContact(profile) && (
        <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-neutral-900">
          <div className="text-sm font-medium">Finalize seu cadastro</div>
          <p className="mt-1 text-xs text-neutral-700 leading-5">
            Adicione seu nome e WhatsApp para facilitar o atendimento.
          </p>
          <div className="mt-3">
            <Link
              href="/profile"
              className="inline-flex items-center justify-center rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-800"
            >
              Completar dados
            </Link>
          </div>
        </div>
      )}

      {profile && hasAddressBasics(profile) && !inCoverage(profile) && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
          <div className="text-sm font-medium">
            Ainda não atendemos sua região
          </div>
          <p className="mt-1 text-xs text-amber-800/90 leading-5">
            Por enquanto entregamos somente na cidade de São Paulo (SP). Se você
            tiver um endereço em São Paulo, pode cadastrá-lo para visualizar os
            produtos.
          </p>
          <div className="mt-3 flex gap-2">
            <Link
              href="/address"
              className="inline-flex items-center justify-center rounded-lg bg-black px-3 py-2 text-xs font-semibold text-white"
            >
              Trocar endereço
            </Link>
            <Link
              href="/profile"
              className="inline-flex items-center justify-center rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-800"
            >
              Meu cadastro
            </Link>
          </div>
        </div>
      )}

      {/* Search + localização — liberado para todos */}
      {!loading && (
        <div className="mt-4 flex gap-2">
          <div className="flex-1 relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <circle cx="11" cy="11" r="7" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" strokeWidth="2" />
              </svg>
            </span>
            <input
              aria-label="Search products"
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-[22px] border border-gray-200 bg-gray-50 pl-9 pr-3 h-11 text-[14px] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>

          <div className="shrink-0">
            <div className="inline-flex items-center gap-1 rounded-[22px] border border-gray-200 bg-white px-3 h-11 text-[12px] text-gray-700">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M12 21s7-4.35 7-10a7 7 0 10-14 0c0 5.65 7 10 7 10z"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="11" r="3" strokeWidth="2" />
              </svg>
              <span className="whitespace-nowrap max-w-[140px] truncate">
                {locationLabel}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Estados */}
      {loading && <p className="mt-6 text-sm text-gray-600">Carregando…</p>}
      {err && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-900">
          <div className="text-sm font-medium">
            Não foi possível carregar seus dados
          </div>
          <p className="mt-1 text-xs text-red-800/90 leading-5">
            {String(err)}
          </p>
        </div>
      )}

      {/* Banner carrossel — liberado para todos */}
      {!loading && (
        <div className="mt-4 overflow-hidden rounded-3xl relative">
          <div
            className="relative h-48 w-full"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            {banners.map((b, i) => (
              <Link
                href={b.href}
                key={i}
                className={`absolute inset-0 transition-opacity duration-700 ${
                  i === currentBanner
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 pointer-events-none"
                }`}
                aria-label={`${b.title} — ${b.subtitle}`}
              >
                <div className="absolute inset-0">
                  <img
                    src={b.image}
                    alt={b.title}
                    className="absolute inset-0 h-full w-full object-cover object-center"
                  />
                </div>
                <div className="absolute inset-0 bg-gradient-to-tr from-black/50 via-black/10 to-transparent" />
                <div className="absolute left-4 bottom-4 right-4 text-white drop-shadow">
                  <div className="text-[22px] font-bold leading-6">
                    {b.title}
                  </div>
                  <div className="text-[13px] opacity-90">{b.subtitle}</div>
                </div>
              </Link>
            ))}
            <button
              type="button"
              aria-label="Anterior"
              onClick={() =>
                setCurrentBanner(
                  (p) => (p - 1 + banners.length) % banners.length
                )
              }
              className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/35 text-white flex items-center justify-center backdrop-blur-sm active:scale-95"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M15 18l-6-6 6-6"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Próximo"
              onClick={() => setCurrentBanner((p) => (p + 1) % banners.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/35 text-white flex items-center justify-center backdrop-blur-sm active:scale-95"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M9 18l6-6-6-6"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
              {banners.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === currentBanner ? "bg-white" : "bg-white/50"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Chips / Filtros — liberados para todos */}
      {!loading && (
        <>
          {anyActiveFilter ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {[...selectedCategories].map((c) => (
                <span
                  key={`c-${c}`}
                  className="px-3 h-9 rounded-full border text-sm capitalize bg-black text-white border-black"
                >
                  {c}
                </span>
              ))}
              {selectedCategories.size === 0 && chipCategory !== "Tudo" && (
                <span className="px-3 h-9 rounded-full border text-sm capitalize bg-black text-white border-black">
                  {chipCategory}
                </span>
              )}
              {[...selectedGenders].map((g) => (
                <span
                  key={`g-${g}`}
                  className="px-3 h-9 rounded-full border text-sm bg-black text-white border-black"
                >
                  {g === "female" ? "Feminino" : "Masculino"}
                </span>
              ))}
              {[...selectedSizes].map((s) => (
                <span
                  key={`s-${s}`}
                  className="px-3 h-9 rounded-full border text-sm bg-black text-white border-black"
                >
                  {s}
                </span>
              ))}
              <button
                type="button"
                onClick={() => {
                  clearFilters();
                  setChipCategory("Tudo");
                }}
                className="px-3 h-9 rounded-full border text-sm bg-white text-gray-800 border-gray-200 hover:bg-gray-50"
              >
                Limpar tudo
              </button>
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between">
              <div className="overflow-x-auto no-scrollbar -ml-1 pr-2">
                <div className="flex gap-2 pl-1">
                  {[
                    "Tudo",
                    "camiseta",
                    "camisa",
                    "vestido",
                    "saia",
                    "calça",
                    "sapato",
                    "bolsa",
                    "jaqueta",
                  ].map((c) => {
                    const active = chipCategory === c;
                    return (
                      <button
                        key={c}
                        onClick={() => setChipCategory(c)}
                        className={`px-3 h-9 rounded-full border text-sm whitespace-nowrap ${
                          active
                            ? "bg-black text-white border-black"
                            : "bg-white text-gray-800 border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        {c[0].toUpperCase() + c.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setFilterOpen(true)}
                className="ml-2 inline-flex items-center gap-1 h-9 px-3 rounded-full border border-gray-200 bg-white text-sm hover:bg-gray-50"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path
                    d="M3 6h18M7 12h10M10 18h4"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                Filter
              </button>
            </div>
          )}

          {/* Modal de filtros */}
          {filterOpen && (
            <div className="fixed inset-0 z-50">
              <div
                className="absolute inset-0 bg-black/30"
                onClick={() => setFilterOpen(false)}
              />
              <div className="absolute inset-x-0 top-0 bottom-0 bg-white rounded-t-3xl shadow-xl flex flex-col">
                {/* header */}
                <div className="sticky top-0 bg-white z-10 border-b">
                  <div className="flex items-center justify-between px-5 h-14">
                    <button
                      className="h-9 w-9 -ml-2 flex items-center justify-center rounded-full hover:bg-gray-100"
                      onClick={() => setFilterOpen(false)}
                      aria-label="Fechar"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                      >
                        <path
                          d="M15 18l-6-6 6-6"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <div className="text-sm font-semibold tracking-wide">
                      FILTROS
                    </div>
                    <button
                      className="text-sm text-gray-600 hover:underline"
                      onClick={() => {
                        clearFilters();
                        setChipCategory("Tudo");
                      }}
                    >
                      Limpar
                    </button>
                  </div>

                  {/* tabs */}
                  <div className="px-5">
                    <div
                      className="flex gap-6 text-sm"
                      role="tablist"
                      aria-label="Filtros"
                    >
                      {[
                        { id: "genero", label: "Gênero" },
                        { id: "tamanho", label: "Tamanho" },
                        { id: "categorias", label: "Categorias" },
                      ].map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setActiveTab(t.id as typeof activeTab)}
                          role="tab"
                          aria-selected={activeTab === t.id}
                          className={`pb-3 -mb-px ${
                            activeTab === t.id
                              ? "text-black border-b-2 border-black"
                              : "text-gray-500"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* content */}
                <div className="flex-1 overflow-y-auto px-5 pt-4">
                  {activeTab === "genero" && (
                    <div className="space-y-3">
                      <div className="text-xs text-gray-500">Selecione</div>
                      <div className="flex gap-2">
                        {[
                          { id: "female", label: "Feminino" },
                          { id: "male", label: "Masculino" },
                        ].map((g) => {
                          const active = selectedGenders.has(
                            g.id as "female" | "male"
                          );
                          return (
                            <button
                              key={g.id}
                              onClick={() =>
                                setSelectedGenders((s) =>
                                  toggleInSet(s, g.id as "female" | "male")
                                )
                              }
                              className={`h-10 px-4 rounded-full border text-sm ${
                                active
                                  ? "bg-black text-white border-black"
                                  : "bg-white text-gray-800 border-gray-200"
                              }`}
                            >
                              {g.label}
                            </button>
                          );
                        })}
                      </div>
                      {selectedGenders.size > 0 && (
                        <button
                          className="text-xs text-gray-600 underline"
                          onClick={() => setSelectedGenders(new Set())}
                        >
                          limpar seleção
                        </button>
                      )}
                    </div>
                  )}

                  {activeTab === "tamanho" && (
                    <div className="space-y-3">
                      <div className="text-xs text-gray-500">
                        Selecione um ou mais tamanhos
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(["PP", "P", "M", "G", "GG"] as const).map((s) => {
                          const active = selectedSizes.has(s);
                          return (
                            <button
                              key={s}
                              onClick={() =>
                                setSelectedSizes((set) => toggleInSet(set, s))
                              }
                              className={`h-10 px-4 rounded-full border text-sm ${
                                active
                                  ? "bg-black text-white border-black"
                                  : "bg-white text-gray-800 border-gray-200"
                              }`}
                            >
                              {s}
                            </button>
                          );
                        })}
                      </div>
                      {selectedSizes.size > 0 && (
                        <button
                          className="text-xs text-gray-600 underline"
                          onClick={() => setSelectedSizes(new Set())}
                        >
                          limpar seleção
                        </button>
                      )}
                    </div>
                  )}

                  {activeTab === "categorias" && (
                    <div className="space-y-3">
                      <div className="text-xs text-gray-500">
                        Marque quantas quiser
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {[
                          "camiseta",
                          "camisa",
                          "vestido",
                          "saia",
                          "calça",
                          "sapato",
                          "bolsa",
                          "jaqueta",
                        ].map((c) => {
                          const key = c.toLowerCase();
                          const active = selectedCategories.has(key);
                          return (
                            <button
                              key={key}
                              onClick={() =>
                                setSelectedCategories((set) =>
                                  toggleInSet(set, key)
                                )
                              }
                              className={`h-10 px-4 rounded-full border text-sm capitalize ${
                                active
                                  ? "bg-black text-white border-black"
                                  : "bg-white text-gray-800 border-gray-200"
                              }`}
                            >
                              {c}
                            </button>
                          );
                        })}
                      </div>
                      {selectedCategories.size > 0 && (
                        <button
                          className="text-xs text-gray-600 underline"
                          onClick={() => setSelectedCategories(new Set())}
                        >
                          limpar seleção
                        </button>
                      )}
                    </div>
                  )}
                  <div className="h-24" />
                </div>

                {/* footer */}
                <div className="sticky bottom-0 bg-white border-t px-5 py-3">
                  <button
                    onClick={() => setFilterOpen(false)}
                    className="w-full h-11 rounded-xl bg-black text-white text-sm font-medium"
                  >
                    Ver resultados
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Grid de produtos — liberado para todos */}
      {!loading && (
        <div className="mt-5 grid grid-cols-2 gap-4">
          {filteredRanked.map((p) => (
            <Link
              key={p.id}
              href={`/product/${p.id}`}
              onClick={() => {
                bumpCategory(p.category);
                bumpStore(p.store_name);
                setViews((prev) => {
                  const next = { ...prev };
                  const k = String(p.id);
                  next[k] = (next[k] || 0) + 1;
                  return next;
                });
              }}
              className="rounded-2xl bg-white shadow-md overflow-hidden hover:shadow-lg transition border border-gray-100"
            >
              <div className="relative h-44">
                <span className="absolute right-2 top-2 rounded-full bg-white/90 backdrop-blur px-2 py-0.5 text-[11px] font-medium shadow border border-gray-200">
                  {formatBRL(p.price_tag)}
                </span>
                <img
                  src={p.photo_url}
                  alt={p.name}
                  className="w-full h-44 object-cover"
                />
                <span className="absolute left-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-black/65 text-white border border-black/20 px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                  >
                    <path
                      d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="3" strokeWidth="2" />
                  </svg>
                  {p.view_count ?? 0}
                </span>
              </div>

              <div className="p-3">
                {p.category ? (
                  <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-0.5">
                    {p.category}
                  </p>
                ) : null}
                <p className="text-sm font-semibold leading-tight line-clamp-2">
                  {p.name}
                </p>
                <p className="text-xs text-gray-500">{p.store_name}</p>
                <p className="text-xs text-gray-400">
                  {p.eta_text ?? "até 1h"}
                </p>
              </div>
            </Link>
          ))}

          {filteredRanked.length === 0 && (
            <p className="col-span-2 mt-4 text-sm text-gray-600">
              Nenhum produto encontrado com os filtros atuais.
            </p>
          )}
        </div>
      )}

      <BottomNav />
      <div style={{ height: "calc(88px + env(safe-area-inset-bottom))" }} />
    </main>
  );
}
