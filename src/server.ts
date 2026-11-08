// src/server.ts
// Atelier: Multi-Tenant Service Operations & High-Concurrency Booking Platform
// Next-Gen Web3 Frosted-Glass Interactive Application Console

import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;

// Multi-Tenant Fixture Store (Aesthetics, Athletics, Wellness)
const TENANTS_STORE: Record<string, any> = {
  'luxe-salon': {
    id: 'tenant-luxe-001',
    name: 'Luxe Salon & Spa',
    slug: 'luxe-salon',
    vertical: 'Haute Coiffure & Aesthetic Rituals',
    tagline: 'Experience world-class French balayage, custom facial transformations, and restorative spa alchemy.',
    professionalRole: {
      title: 'Service Provider / Specialist',
      shortTitle: 'Service Provider',
      scopeLabel: 'My Assigned Clients',
      icon: '✂️',
      description: 'My Assigned Clients & Personal Schedule',
      wizardTitle: 'Select Your Service Provider',
      wizardSubtitle: 'Master specialists & estheticians certified for your service'
    },
    branch: 'Beverly Hills Flagship • 450 N Rodeo Dr',
    accentGlow: 'from-fuchsia-600/30 via-violet-600/20 to-transparent',
    accentColor: '#d946ef',
    services: [
      { id: 'svc-haircut', category: 'Hair', name: 'Signature Precision Cut & Blowout', duration: 45, price: 2500, rating: '4.9 (128)', image: 'https://images.unsplash.com/photo-1560869713-7d0a29430803?w=600&auto=format&fit=crop&q=80', description: 'Sculpted haircut tailored to facial geometry, botanical scalp wash, and signature thermal glaze blowout.' },
      { id: 'svc-balayage', category: 'Color', name: 'Bespoke Parisian Balayage', duration: 90, price: 6500, rating: '5.0 (94)', image: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=600&auto=format&fit=crop&q=80', description: 'Hand-painted multi-dimensional dimensional highlights, bond-repair plex treatment, and custom tone glaze.' },
      { id: 'svc-facial', category: 'Skin', name: 'Cryo-Oxygen Radiance Facial', duration: 60, price: 4200, rating: '4.9 (76)', image: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=600&auto=format&fit=crop&q=80', description: 'Sub-zero cryo-lymphatic drainage, dual hyaluronic mist, and peptide dermal regeneration.' },
      { id: 'svc-massage', category: 'Wellness', name: 'Deep Release Magnesium Ritual', duration: 60, price: 3800, rating: '4.8 (112)', image: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=600&auto=format&fit=crop&q=80', description: 'Targeted myofascial release with transdermal magnesium and warm volcanic basalt stones.' }
    ],
    staff: [
      { id: 'stf-sofia', name: 'Sofia Rodriguez', title: 'Master Color Director', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80', certified: ['svc-haircut', 'svc-balayage'], experience: '9 yrs', baseSalary: '₹85,000/mo', commission: '18%', todayEarnings: '₹4,680' },
      { id: 'stf-chloe', name: 'Chloe Chen', title: 'Senior Dermal Esthetician', avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=300&auto=format&fit=crop&q=80', certified: ['svc-facial', 'svc-massage'], experience: '7 yrs', baseSalary: '₹68,000/mo', commission: '15%', todayEarnings: '₹2,520' },
      { id: 'stf-marcus', name: 'Marcus Vance', title: 'Artistic Director & Barber', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop&q=80', certified: ['svc-haircut'], experience: '8 yrs', baseSalary: '₹60,000/mo', commission: '14%', todayEarnings: '₹1,500' }
    ],
    appointments: [
      { id: 'APT-101', customer: 'Aria Montgomery', phone: '+91 98200 11223', service: 'Signature Precision Cut & Blowout', staff: 'Sofia Rodriguez', time: '10:00 AM', status: 'COMPLETED', price: 2500, payment: 'PAID', tender: 'Cash (₹1,000) + UPI (₹1,500)' },
      { id: 'APT-102', customer: 'Devika Patel', phone: '+91 98111 22334', service: 'Cryo-Oxygen Radiance Facial', staff: 'Chloe Chen', time: '11:30 AM', status: 'IN_SERVICE', price: 4200, payment: 'PAID', tender: 'Stripe Credit Card' },
      { id: 'APT-103', customer: 'Zoya Khan', phone: '+91 99333 44556', service: 'Bespoke Parisian Balayage', staff: 'Sofia Rodriguez', time: '02:00 PM', status: 'CONFIRMED', price: 6500, payment: 'DUE_AT_DESK', tender: 'Pay at Counter' }
    ],
    drawer: {
      openingFloat: 5000,
      cashCollected: 3500,
      vouchers: [
        { id: 'VCH-01', category: 'Client Hospitality', desc: 'Fresh Organic Espresso & Macarons', amount: 320, paidTo: 'Artisan Bakery', time: '09:45 AM', status: 'APPROVED' },
        { id: 'VCH-02', category: 'Floor Supplies', desc: 'Medical Grade Foils & Sanitizer', amount: 480, paidTo: 'Dermal Supply Co', time: '11:15 AM', status: 'APPROVED' }
      ]
    }
  },
  'iron-forge': {
    id: 'tenant-iron-forge-002',
    name: 'Iron Forge Athletic Center',
    slug: 'iron-forge',
    vertical: 'Elite Strength & Biomechanics',
    tagline: 'Laser velocity barbell tracking, kinematic squat/bench optimization, and elite athletic conditioning.',
    professionalRole: {
      title: 'Strength Coach / Trainer',
      shortTitle: 'Coach',
      scopeLabel: 'My Assigned Athletes',
      icon: '🏋️',
      description: 'My Assigned Athletes & Training Blocks',
      wizardTitle: 'Select Your Strength Coach',
      wizardSubtitle: 'CSCS coaches certified for biomechanical and barbell protocols'
    },
    branch: 'Downtown Performance Lab • 100 Industrial Blvd',
    accentGlow: 'from-amber-600/30 via-orange-600/20 to-transparent',
    accentColor: '#f97316',
    services: [
      { id: 'svc-powerlifting', category: 'Strength', name: '1-on-1 Velocity Barbell Coaching', duration: 60, price: 2000, rating: '5.0 (140)', image: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=600&auto=format&fit=crop&q=80', description: 'Laser velocity barbell tracking, kinematic squat/bench optimization, and motor unit recruitment.' },
      { id: 'svc-fms', category: 'Screening', name: 'Full Biomechanical Movement Screen', duration: 45, price: 1600, rating: '4.9 (88)', image: 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=600&auto=format&fit=crop&q=80', description: 'High-speed video joint angle breakdown, asymmetry detection, and customized prehab protocol.' }
    ],
    staff: [
      { id: 'stf-jake', name: 'Jake Thorburn, CSCS', title: 'Head Strength Coach', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop&q=80', certified: ['svc-powerlifting', 'svc-fms'], experience: '11 yrs', baseSalary: '₹80,000/mo', commission: '20%', todayEarnings: '₹3,200' }
    ],
    appointments: [
      { id: 'APT-201', customer: 'Rohan Sharma', phone: '+91 98777 00112', service: '1-on-1 Velocity Barbell Coaching', staff: 'Jake Thorburn, CSCS', time: '07:30 AM', status: 'COMPLETED', price: 2000, payment: 'PAID', tender: 'UPI' }
    ],
    drawer: {
      openingFloat: 3000,
      cashCollected: 2000,
      vouchers: [
        { id: 'VCH-10', category: 'Equipment Maintenance', desc: 'Barbell Chalk Block Refill & Grip Tape', amount: 350, paidTo: 'Rogue India', time: '08:30 AM', status: 'APPROVED' }
      ]
    }
  },
  'prana-yoga': {
    id: 'tenant-prana-yoga-003',
    name: 'Prana Yoga Sanctuary',
    slug: 'prana-yoga',
    vertical: 'Mysore Ashtanga & Sound Alchemy',
    tagline: 'Traditional Mysore Ashtanga immersion, 7-chakra sound bath alchemy, and deep nervous system restoration.',
    professionalRole: {
      title: 'Yoga Instructor / Guide',
      shortTitle: 'Instructor',
      scopeLabel: 'My Scheduled Classes',
      icon: '🧘',
      description: 'My Scheduled Classes & Private Immersions',
      wizardTitle: 'Select Your Yogacharya Guide',
      wizardSubtitle: 'Lineage-trained instructors for Mysore adjustments & sound bath'
    },
    branch: 'Lotus Main Shala • 12 Peace Garden Way',
    accentGlow: 'from-emerald-600/30 via-teal-600/20 to-transparent',
    accentColor: '#10b981',
    services: [
      { id: 'svc-ashtanga', category: 'Yoga', name: 'Private Mysore Ashtanga Immersion', duration: 75, price: 2400, rating: '5.0 (65)', image: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600&auto=format&fit=crop&q=80', description: 'Traditional individualized posture adjustments, ujjayi pranayama refinement, and bandha lockwork.' },
      { id: 'svc-sound', category: 'Healing', name: '7-Chakra Tibetan Singing Bowl Bath', duration: 60, price: 2800, rating: '4.9 (82)', image: 'https://images.unsplash.com/photo-1518241353330-0f7941c2d9b5?w=600&auto=format&fit=crop&q=80', description: 'Harmonic overtone acoustic immersion to down-regulate sympathetic nervous tone.' }
    ],
    staff: [
      { id: 'stf-ananya', name: 'Ananya Sharma', title: 'Senior Yogacharya & Alchemist', avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=300&auto=format&fit=crop&q=80', certified: ['svc-ashtanga', 'svc-sound'], experience: '12 yrs', baseSalary: '₹72,000/mo', commission: '25%', todayEarnings: '₹3,500' }
    ],
    appointments: [
      { id: 'APT-301', customer: 'Kabir Mehta', phone: '+91 99888 77665', service: '7-Chakra Tibetan Singing Bowl Bath', staff: 'Ananya Sharma', time: '09:00 AM', status: 'COMPLETED', price: 2800, payment: 'PAID', tender: 'Card / Stripe' }
    ],
    drawer: {
      openingFloat: 2000,
      cashCollected: 2800,
      vouchers: [
        { id: 'VCH-20', category: 'Sanctuary Ambiance', desc: 'Organic Tulsi Infusion & Sandalwood Incense', amount: 240, paidTo: 'Ayur Organics', time: '09:15 AM', status: 'APPROVED' }
      ]
    }
  }
};

function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atelier — Next-Gen Service Operations & Online Experience</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Cinzel:wght@500;600;700;800&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Plus Jakarta Sans', 'sans-serif'],
            display: ['Space Grotesk', 'sans-serif'],
            luxury: ['Cinzel', 'serif'],
          },
          colors: {
            obsidian: '#080a0f',
            surface: {
              100: 'rgba(255, 255, 255, 0.03)',
              200: 'rgba(255, 255, 255, 0.05)',
              300: 'rgba(255, 255, 255, 0.08)',
              solid: '#0f141f',
              border: 'rgba(255, 255, 255, 0.1)',
              glow: 'rgba(255, 255, 255, 0.04)',
            }
          }
        }
      }
    }
  </script>
  <style>
    /* Web3 Neon & Depth Glow Effects */
    body {
      background-color: #07090e;
      background-image: 
        radial-gradient(at 0% 0%, rgba(168, 85, 247, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.12) 0px, transparent 50%),
        radial-gradient(at 50% 50%, rgba(217, 70, 239, 0.08) 0px, transparent 60%);
      background-attachment: fixed;
    }
    
    .glass-panel {
      background: rgba(15, 20, 31, 0.65);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.09);
      box-shadow: 
        0 20px 40px -15px rgba(0, 0, 0, 0.7),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }

    .glass-card {
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.04) 0%, rgba(255, 255, 255, 0.01) 100%);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .glass-card:hover {
      border-color: rgba(217, 70, 239, 0.4);
      box-shadow: 
        0 12px 30px -10px rgba(0, 0, 0, 0.8),
        0 0 20px -3px rgba(217, 70, 239, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
      transform: translateY(-2px);
    }

    .neon-pill {
      box-shadow: 0 0 15px -3px currentColor;
    }

    /* Native Select & Option Dark Overrides */
    select {
      color-scheme: dark !important;
      background-color: #0b0f19 !important;
      color: #f1f5f9 !important;
    }
    select option {
      background-color: #0d121f !important;
      color: #f8fafc !important;
      padding: 8px 12px;
    }
    select option:hover, select option:checked {
      background-color: #7c3aed !important;
      color: #ffffff !important;
    }

    /* Custom Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #07090e; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 999px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="text-slate-100 min-h-screen flex flex-col font-sans selection:bg-fuchsia-500 selection:text-white">

  <!-- ========================================================================= -->
  <!-- TOP WEB3 NAVIGATION BAR                                                    -->
  <!-- ========================================================================= -->
  <header class="glass-panel sticky top-0 z-50 border-b border-surface-border">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
      
      <!-- Logo & Business Vertical Switcher -->
      <div class="flex items-center gap-3">
        <div class="relative group">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-fuchsia-600 via-violet-600 to-cyan-500 p-[1px] shadow-lg shadow-fuchsia-500/20">
            <div class="w-full h-full bg-obsidian rounded-xl flex items-center justify-center font-display font-extrabold text-sm text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 to-cyan-400">
              A
            </div>
          </div>
          <div class="absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-obsidian"></div>
        </div>

        <div class="flex flex-col">
          <div class="flex items-center gap-2">
            <span class="font-display font-bold tracking-wider text-base text-white">ATELIER</span>
            <span class="text-[10px] font-mono tracking-widest px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/30">v2.4 PROD</span>
          </div>
        </div>

        <div class="h-6 w-px bg-white/10 mx-1 hidden sm:block"></div>

        <!-- Tenant Selector Custom Frosted Glass Dropdown -->
        <div class="relative" id="customTenantDropdown">
          <button type="button" onclick="toggleTenantDropdown(event)" class="group flex items-center gap-2 bg-surface-200 hover:bg-surface-300 text-xs font-semibold text-white/90 border border-surface-border hover:border-fuchsia-500/50 rounded-xl px-3.5 py-2 transition-all cursor-pointer shadow-lg shadow-black/20 focus:outline-none">
            <span id="selectedTenantIcon" class="text-sm">💇</span>
            <span id="selectedTenantLabel">Luxe Salon & Spa (Luxury)</span>
            <svg id="tenantChevron" class="w-3.5 h-3.5 text-white/50 ml-1 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </button>

          <!-- Dropdown Menu -->
          <div id="tenantDropdownMenu" class="hidden absolute left-0 mt-2 w-72 glass-panel bg-[#0d121f]/95 backdrop-blur-2xl border border-white/15 rounded-2xl p-1.5 shadow-2xl shadow-black/90 z-50">
            <div class="px-2.5 py-1.5 text-[10px] font-mono tracking-wider uppercase text-slate-400 font-semibold border-b border-white/5 mb-1">Select Multi-Tenant Domain</div>
            
            <div onclick="selectTenant('luxe-salon')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-fuchsia-600/20 hover:border-fuchsia-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/30 flex items-center justify-center text-sm">💇</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-fuchsia-300 transition-colors">Luxe Salon & Spa</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40">Luxury</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">Beverly Hills Flagship</p>
              </div>
            </div>

            <div onclick="selectTenant('iron-forge')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-amber-600/20 hover:border-amber-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-sm">🏋️</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-amber-300 transition-colors">Iron Forge Athletic Lab</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">Fitness</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">Downtown Performance Lab</p>
              </div>
            </div>

            <div onclick="selectTenant('prana-yoga')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-emerald-600/20 hover:border-emerald-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-sm">🧘</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-emerald-300 transition-colors">Prana Yoga Sanctuary</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Wellness</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">Lotus Main Shala</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Center: Switch Between Client Experience vs Staff Workplace -->
      <div class="flex items-center p-1 rounded-xl bg-obsidian/80 border border-surface-border p-1">
        <button id="btnClientPortal" onclick="switchView('client')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 bg-gradient-to-r from-fuchsia-600 to-violet-600 text-white shadow-lg shadow-fuchsia-500/25">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path></svg>
          <span>Online Guest Booking</span>
        </button>

        <button id="btnStaffPortal" onclick="switchView('staff')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 text-slate-400 hover:text-white">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
          <span>Operations & Admin Portal</span>
        </button>
      </div>

      <!-- Right: Role Switcher Custom Frosted Glass Dropdown (Enabled in Staff Workplace) -->
      <div id="roleSelectorWidget" class="hidden flex items-center gap-2">
        <div class="relative" id="customRoleDropdown">
          <button type="button" onclick="toggleRoleDropdown(event)" class="group flex items-center gap-2 bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 hover:text-white text-xs font-bold border border-violet-500/40 hover:border-violet-400 rounded-xl px-3.5 py-2 transition-all cursor-pointer shadow-lg shadow-violet-950/30 focus:outline-none">
            <span id="selectedRoleIcon" class="text-sm">👑</span>
            <span id="selectedRoleLabel">Owner (Full P&L & Compensation)</span>
            <svg id="roleChevron" class="w-3.5 h-3.5 text-violet-400 ml-1 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </button>

          <!-- Dropdown Menu -->
          <div id="roleDropdownMenu" class="hidden absolute right-0 mt-2 w-80 glass-panel bg-[#0d121f]/95 backdrop-blur-2xl border border-violet-500/40 rounded-2xl p-1.5 shadow-2xl shadow-black/90 z-50">
            <div class="px-2.5 py-1.5 text-[10px] font-mono tracking-wider uppercase text-violet-400 font-semibold border-b border-white/5 mb-1">Simulate Staff Role (RBAC)</div>

            <div onclick="selectRole('OWNER')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-violet-600/20 hover:border-violet-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-sm">👑</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-violet-300 transition-colors">Owner</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/40">Full Access</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">Total P&L, Staff Salaries & Compensation</p>
              </div>
            </div>

            <div onclick="selectRole('MANAGER')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-violet-600/20 hover:border-violet-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-sm">🏢</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-violet-300 transition-colors">Branch Manager</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">Floor Lead</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">Floor Operations & Petty Cash Vouchers</p>
              </div>
            </div>

            <div onclick="selectRole('RECEPTIONIST')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-violet-600/20 hover:border-violet-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-sm">🛎️</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-violet-300 transition-colors">Front Desk Operator</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">Desk POS</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate">POS Walk-in Booking & Cash Drawer Float</p>
              </div>
            </div>

            <div onclick="selectRole('SERVICE_PROVIDER')" class="flex items-center gap-3 p-2 rounded-xl hover:bg-violet-600/20 hover:border-violet-500/40 border border-transparent transition-all cursor-pointer group">
              <div class="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-sm" id="roleItemProviderIcon">✂️</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white group-hover:text-violet-300 transition-colors" id="roleItemProviderTitle">Service Provider / Specialist</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40">Restricted</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate" id="roleItemProviderDesc">My Assigned Clients & Personal Commission</p>
              </div>
            </div>

          </div>
        </div>
      </div>

    </div>
  </header>

  <!-- ========================================================================= -->
  <!-- 1. PUBLIC STOREFRONT (LUXURY CLIENT BOOKING WIZARD)                       -->
  <!-- ========================================================================= -->
  <main id="clientViewContainer" class="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-8">

    <!-- Hero Glass Showcase -->
    <div class="glass-panel rounded-3xl p-8 sm:p-12 mb-10 relative overflow-hidden border border-white/10">
      <div class="absolute -right-20 -top-20 w-96 h-96 rounded-full bg-gradient-to-br from-fuchsia-600/20 via-violet-600/15 to-transparent blur-3xl pointer-events-none"></div>

      <div class="max-w-3xl relative z-10">
        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-xs font-semibold text-fuchsia-300 mb-4">
          <span class="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse"></span>
          <span id="heroBadge">HAUTE COIFFURE & SPA RITUALS</span>
        </div>

        <h1 class="text-3xl sm:text-5xl font-luxury font-bold tracking-tight text-white mb-4 leading-tight" id="heroTitle">
          Luxe Salon & Spa
        </h1>
        <p class="text-slate-300 text-sm sm:text-base leading-relaxed mb-6 font-light" id="heroTagline">
          Experience world-class French balayage, custom facial transformations, and restorative spa alchemy.
        </p>

        <div class="flex flex-wrap items-center gap-4 text-xs text-slate-300">
          <div class="flex items-center gap-2 bg-surface-200 px-3.5 py-2 rounded-xl border border-surface-border">
            <svg class="w-4 h-4 text-fuchsia-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            <span id="heroBranch">Beverly Hills Flagship • 450 N Rodeo Dr</span>
          </div>

          <div class="flex items-center gap-2 bg-emerald-500/10 text-emerald-400 px-3.5 py-2 rounded-xl border border-emerald-500/30">
            <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>Real-Time GiST Slots Active</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Booking Step Progress Indicator -->
    <div class="max-w-3xl mx-auto mb-10">
      <div class="flex items-center justify-between text-xs font-bold font-display uppercase tracking-wider">
        <div class="flex items-center gap-2 text-fuchsia-400" id="step1Ind">
          <div class="w-7 h-7 rounded-lg bg-fuchsia-500/20 border border-fuchsia-500 flex items-center justify-center text-xs">01</div>
          <span>Service</span>
        </div>
        <div class="h-px flex-1 mx-4 bg-white/10"></div>
        <div class="flex items-center gap-2 text-slate-500" id="step2Ind">
          <div class="w-7 h-7 rounded-lg bg-surface-200 border border-white/10 flex items-center justify-center text-xs">02</div>
          <span id="step2IndicatorLabel">Provider</span>
        </div>
        <div class="h-px flex-1 mx-4 bg-white/10"></div>
        <div class="flex items-center gap-2 text-slate-500" id="step3Ind">
          <div class="w-7 h-7 rounded-lg bg-surface-200 border border-white/10 flex items-center justify-center text-xs">03</div>
          <span>Slot</span>
        </div>
        <div class="h-px flex-1 mx-4 bg-white/10"></div>
        <div class="flex items-center gap-2 text-slate-500" id="step4Ind">
          <div class="w-7 h-7 rounded-lg bg-surface-200 border border-white/10 flex items-center justify-center text-xs">04</div>
          <span>Ticket</span>
        </div>
      </div>
    </div>

    <!-- STEP 1: SERVICE MENU -->
    <div id="step1Card">
      <div class="flex justify-between items-end mb-6">
        <div>
          <h2 class="text-xl font-bold font-display text-white">Curated Signature Menu</h2>
          <p class="text-xs text-slate-400 mt-1">Select an artisan service to schedule your appointment</p>
        </div>
      </div>
      <div id="servicesGrid" class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6"></div>
    </div>

    <!-- STEP 2: CHOOSE SERVICE PROVIDER -->
    <div id="step2Card" class="hidden">
      <button onclick="navStep(1)" class="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 mb-6 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
        Back to Services
      </button>

      <div class="mb-6">
        <h2 class="text-xl font-bold font-display text-white" id="step2Heading">Select Your Service Provider</h2>
        <p class="text-xs text-slate-400 mt-1" id="step2Subheading">Specialists certified for your selected service</p>
      </div>

      <div id="staffGrid" class="grid sm:grid-cols-3 gap-6 max-w-4xl mx-auto"></div>
    </div>

    <!-- STEP 3: DATE & TIME SELECTION -->
    <div id="step3Card" class="hidden">
      <button onclick="navStep(2)" class="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 mb-6 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
        Back to Specialist
      </button>

      <div class="max-w-2xl mx-auto glass-panel p-8 rounded-3xl border border-white/10">
        <h2 class="text-xl font-bold font-display text-white mb-1">Pick a Protected Slot</h2>
        <p class="text-xs text-slate-400 mb-6">Real-time availability computed against staff breaks and station holds</p>

        <!-- Date Selector -->
        <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Target Date</label>
        <div class="grid grid-cols-4 gap-2.5 mb-6">
          <button onclick="chooseDate(this, 'Fri, Nov 6')" class="date-chip bg-fuchsia-600/20 border border-fuchsia-500 text-fuchsia-300 py-3 rounded-xl text-center font-bold text-xs">
            <div class="text-[10px] uppercase text-fuchsia-400">TODAY</div>
            <div>Nov 6</div>
          </button>
          <button onclick="chooseDate(this, 'Sat, Nov 7')" class="date-chip bg-surface-100 hover:bg-surface-200 border border-surface-border py-3 rounded-xl text-center font-bold text-xs text-slate-300">
            <div class="text-[10px] uppercase text-slate-500">SAT</div>
            <div>Nov 7</div>
          </button>
          <button onclick="chooseDate(this, 'Sun, Nov 8')" class="date-chip bg-surface-100 hover:bg-surface-200 border border-surface-border py-3 rounded-xl text-center font-bold text-xs text-slate-300">
            <div class="text-[10px] uppercase text-slate-500">SUN</div>
            <div>Nov 8</div>
          </button>
          <button onclick="chooseDate(this, 'Mon, Nov 9')" class="date-chip bg-surface-100 hover:bg-surface-200 border border-surface-border py-3 rounded-xl text-center font-bold text-xs text-slate-300">
            <div class="text-[10px] uppercase text-slate-500">MON</div>
            <div>Nov 9</div>
          </button>
        </div>

        <!-- Slot Matrix -->
        <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Available Time Windows</label>
        <div class="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mb-8">
          <button onclick="chooseSlot(this, '10:00 AM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">10:00 AM</button>
          <button onclick="chooseSlot(this, '11:15 AM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">11:15 AM</button>
          <button onclick="chooseSlot(this, '12:30 PM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">12:30 PM</button>
          <button onclick="chooseSlot(this, '02:00 PM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">02:00 PM</button>
          <button onclick="chooseSlot(this, '03:30 PM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">03:30 PM</button>
          <button onclick="chooseSlot(this, '05:00 PM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">05:00 PM</button>
          <button onclick="chooseSlot(this, '06:15 PM')" class="slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200">06:15 PM</button>
        </div>

        <button id="btnProceedToGuest" onclick="navStep(4)" disabled class="w-full bg-slate-800 text-slate-500 py-3.5 rounded-xl font-display font-bold text-xs uppercase tracking-wider cursor-not-allowed transition-all">
          Select a Time Slot to Proceed →
        </button>
      </div>
    </div>

    <!-- STEP 4: GUEST INFO & ONE-TIME PASSCODE (OTP) -->
    <div id="step4Card" class="hidden">
      <button onclick="navStep(3)" class="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 mb-6 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
        Back to Time Slot
      </button>

      <div class="max-w-xl mx-auto glass-panel p-8 rounded-3xl border border-white/10">
        <div class="flex items-center gap-2 mb-2">
          <div class="w-2 h-2 rounded-full bg-fuchsia-400"></div>
          <span class="text-xs font-bold text-fuchsia-400 font-display tracking-wider uppercase">Secure Checkout</span>
        </div>
        <h2 class="text-xl font-bold font-display text-white mb-1">Guest Identification & OTP</h2>
        <p class="text-xs text-slate-400 mb-6">Protects against automated slot hoarding and duplicate bookings</p>

        <!-- Dynamic Summary Card -->
        <div class="bg-surface-200/50 rounded-2xl p-4 border border-surface-border mb-6 flex justify-between items-center">
          <div>
            <div class="text-xs text-fuchsia-400 font-bold uppercase tracking-wider" id="ticketServiceCat">Hair</div>
            <h4 class="font-bold text-sm text-white mt-0.5" id="ticketServiceName">Signature Precision Cut</h4>
            <div class="text-xs text-slate-400 mt-1">With <span id="ticketStaffName" class="text-slate-200 font-semibold">Sofia Rodriguez</span></div>
          </div>
          <div class="text-right">
            <div class="font-mono text-lg font-bold text-emerald-400" id="ticketPrice">₹2,500</div>
            <div class="text-[11px] text-slate-400" id="ticketSlotTime">Nov 6 • 10:00 AM</div>
          </div>
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Guest Name</label>
            <input type="text" id="guestNameInput" value="Priya Sharma" class="w-full bg-surface-100 border border-surface-border focus:border-fuchsia-500 rounded-xl px-4 py-3 text-sm text-white focus:outline-none transition-all">
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Mobile Number (India or International)</label>
            <input type="tel" id="guestPhoneInput" oninput="formatPhoneRealtime(this.value)" value="9820011223" class="w-full bg-surface-100 border border-surface-border focus:border-fuchsia-500 rounded-xl px-4 py-3 text-sm text-white font-mono focus:outline-none transition-all">
            <div class="flex items-center gap-1.5 mt-2 text-xs text-emerald-400 font-mono" id="phoneNormalizedPill">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
              <span>E.164: +919820011223 (Validated)</span>
            </div>
          </div>

          <!-- Simulated OTP Modal Drawer -->
          <div id="otpDrawer" class="hidden bg-fuchsia-950/30 border border-fuchsia-500/30 p-5 rounded-2xl mt-4">
            <div class="flex justify-between items-center mb-2">
              <span class="text-xs font-bold text-fuchsia-300">Enter Verification Code</span>
              <span class="text-[10px] bg-fuchsia-500/20 text-fuchsia-300 px-2 py-0.5 rounded font-mono">CODE: 482910</span>
            </div>
            <p class="text-[11px] text-slate-400 mb-3">Simulated SMS code delivered to your registered device</p>
            <input type="text" id="otpDigitInput" placeholder="4 8 2 9 1 0" maxlength="6" class="w-full bg-obsidian text-center font-mono text-xl tracking-[0.5em] font-extrabold border border-fuchsia-500/50 rounded-xl py-2.5 text-white focus:outline-none">
          </div>

          <button id="btnSendOTP" onclick="triggerOTP()" class="w-full bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-display font-bold text-xs uppercase tracking-wider py-4 rounded-xl shadow-lg shadow-fuchsia-500/20 transition-all cursor-pointer">
            Send Verification Code
          </button>

          <button id="btnConfirmReservation" onclick="sealReservation()" class="hidden w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-display font-bold text-xs uppercase tracking-wider py-4 rounded-xl shadow-lg shadow-emerald-500/20 transition-all cursor-pointer">
            Seal Reservation & Issue Ticket ✓
          </button>
        </div>
      </div>
    </div>

    <!-- STEP 5: TICKET SUCCESS SCREEN -->
    <div id="step5Card" class="hidden max-w-xl mx-auto py-10">
      <div class="glass-panel p-8 rounded-3xl border border-emerald-500/30 relative overflow-hidden text-center">
        
        <div class="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 mx-auto mb-4">
          <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
        </div>

        <h3 class="text-2xl font-display font-bold text-white mb-1">Reservation Confirmed</h3>
        <p class="text-xs text-slate-400 mb-6">Slot successfully acquired with GiST exclusion lock.</p>

        <!-- Boarding Pass Style Digital Ticket -->
        <div class="bg-obsidian/80 rounded-2xl p-6 border border-white/10 text-left mb-6 relative">
          <div class="flex justify-between items-center border-b border-white/10 pb-3 mb-4">
            <div>
              <span class="text-[10px] font-mono text-slate-400 uppercase tracking-widest">APPOINTMENT TICKET</span>
              <div class="font-mono text-xs font-bold text-fuchsia-400 mt-0.5" id="finalTicketId">APT-8921</div>
            </div>
            <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-semibold">
              <span>●</span> Confirmed
            </div>
          </div>

          <div class="space-y-2.5 text-xs">
            <div class="flex justify-between"><span class="text-slate-400">Ritual:</span><strong class="text-white" id="finalServiceName">Bespoke Parisian Balayage</strong></div>
            <div class="flex justify-between"><span class="text-slate-400">Artisan:</span><strong class="text-white" id="finalStaffName">Sofia Rodriguez</strong></div>
            <div class="flex justify-between"><span class="text-slate-400">Date & Window:</span><strong class="text-white font-mono" id="finalSlotTime">Fri, Nov 6 • 10:00 AM</strong></div>
            <div class="flex justify-between"><span class="text-slate-400">Guest:</span><strong class="text-white" id="finalGuestName">Priya Sharma</strong></div>
            <div class="flex justify-between border-t border-white/10 pt-3"><span class="text-slate-400 font-bold">Total Due at Desk:</span><strong class="text-base font-mono text-emerald-400 font-bold" id="finalPrice">₹2,500</strong></div>
          </div>

          <div class="mt-5 p-3 rounded-xl bg-white/[0.03] border border-white/5 flex items-center gap-2.5 text-[11px] text-slate-300">
            <svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
            <span>Transactional outbox message queued. WhatsApp confirmation delivered to client.</span>
          </div>
        </div>

        <div class="flex gap-3">
          <button onclick="navStep(1)" class="flex-1 bg-surface-200 hover:bg-surface-300 text-white py-3 rounded-xl text-xs font-bold transition-all">Book Another Ritual</button>
          <button onclick="switchView('staff')" class="flex-1 bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white py-3 rounded-xl text-xs font-bold transition-all">Inspect in Staff Admin →</button>
        </div>

      </div>
    </div>

  </main>


  <!-- ========================================================================= -->
  <!-- 2. OPERATIONS & ADMIN WORKPLACE (ROLE-BASED COCKPIT)                      -->
  <!-- ========================================================================= -->
  <main id="staffViewContainer" class="hidden flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-8">

    <!-- Workplace Sub-Header & Live KPIs -->
    <div class="glass-panel p-6 sm:p-8 rounded-3xl mb-8 border border-white/10">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-md bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40" id="badgeRoleTitle">ROLE: OWNER</span>
            <span class="text-xs text-slate-500">•</span>
            <span class="text-xs text-slate-400 font-semibold" id="adminBranchText">Beverly Hills Flagship</span>
          </div>
          <h2 class="text-2xl font-display font-bold text-white mt-1">Operations & Ledger Control</h2>
        </div>

        <div class="flex items-center gap-3">
          <button onclick="openWalkinModal()" class="px-4 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-display font-bold text-xs flex items-center gap-2 shadow-lg shadow-fuchsia-500/20 transition-all cursor-pointer">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
            <span>Walk-in Quick POS</span>
          </button>

          <button onclick="openVoucherModal()" id="btnQuickVoucher" class="px-4 py-2.5 rounded-xl bg-surface-200 hover:bg-surface-300 text-white font-display font-bold text-xs flex items-center gap-2 border border-surface-border transition-all cursor-pointer">
            <svg class="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
            <span>Issue Petty Cash</span>
          </button>
        </div>
      </div>

      <!-- Live Metric Grid -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="glass-card p-4 rounded-2xl" id="kpiRevenueCard">
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Gross Realized Revenue</span>
          <div class="text-2xl font-mono font-bold text-white mt-1" id="kpiGrossRev">₹13,200</div>
          <div class="text-[11px] text-emerald-400 font-semibold mt-1 flex items-center gap-1">
            <span>↑ 14%</span> <span class="text-slate-500">vs yesterday</span>
          </div>
        </div>

        <div class="glass-card p-4 rounded-2xl">
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Total Bookings Today</span>
          <div class="text-2xl font-mono font-bold text-white mt-1" id="kpiAptCount">3</div>
          <div class="text-[11px] text-fuchsia-400 font-semibold mt-1">1 In-Service • 1 Confirmed</div>
        </div>

        <div class="glass-card p-4 rounded-2xl" id="kpiDrawerCard">
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Cash Drawer Expected</span>
          <div class="text-2xl font-mono font-bold text-emerald-400 mt-1" id="kpiDrawerCash">₹7,700</div>
          <div class="text-[11px] text-slate-400 mt-1">Float + Walk-ins - Vouchers</div>
        </div>

        <div class="glass-card p-4 rounded-2xl">
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Specialist Capacity</span>
          <div class="text-2xl font-mono font-bold text-white mt-1">82%</div>
          <div class="text-[11px] text-violet-400 font-semibold mt-1">3 Specialists on shift</div>
        </div>
      </div>
    </div>

    <!-- Tabbed Workplace Views: Schedule, Petty Cash Voucher System, Staff Compensation -->
    <div class="glass-panel rounded-3xl overflow-hidden border border-white/10">
      
      <!-- Inner Tabs -->
      <div class="border-b border-white/10 px-6 pt-4 flex gap-6 text-xs font-bold font-display uppercase tracking-wider">
        <button onclick="switchWorkTab('schedule')" id="workTabSchedule" class="pb-4 border-b-2 border-fuchsia-500 text-fuchsia-400 flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
          Floor Calendar & Rescheduling
        </button>

        <button onclick="switchWorkTab('drawer')" id="workTabDrawer" class="pb-4 border-b-2 border-transparent text-slate-400 hover:text-white flex items-center gap-2">
          <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          Cash Drawer & Petty Cash Voucher System
        </button>

        <button onclick="switchWorkTab('staff')" id="workTabStaff" class="pb-4 border-b-2 border-transparent text-slate-400 hover:text-white flex items-center gap-2">
          <svg class="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
          Staff & 4-Axis Compensation
        </button>
      </div>

      <!-- 1. APPOINTMENT SCHEDULE TAB -->
      <div id="workScheduleView" class="p-6">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-surface-100 text-slate-400 uppercase font-mono tracking-wider border-y border-white/5">
              <tr>
                <th class="py-3 px-4">Time</th>
                <th class="py-3 px-4">Client</th>
                <th class="py-3 px-4">Ritual / Service</th>
                <th class="py-3 px-4">Specialist</th>
                <th class="py-3 px-4">Price</th>
                <th class="py-3 px-4">Status</th>
                <th class="py-3 px-4">Tender Method</th>
                <th class="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody id="adminAptTableBody" class="divide-y divide-white/5 font-medium"></tbody>
          </table>
        </div>
      </div>

      <!-- 2. CASH DRAWER & PETTY CASH VOUCHER SYSTEM TAB -->
      <div id="workDrawerView" class="hidden p-6">
        <!-- Drawer Balance Overview Card -->
        <div class="grid sm:grid-cols-3 gap-4 mb-8">
          <div class="glass-card p-5 rounded-2xl">
            <span class="text-[10px] font-mono uppercase text-slate-400">Shift Opening Float</span>
            <div class="text-xl font-mono font-bold text-white mt-1" id="vchFloatText">₹5,000.00</div>
            <div class="text-[11px] text-slate-500 mt-1">Counted at 08:30 AM Shift Start</div>
          </div>

          <div class="glass-card p-5 rounded-2xl border-emerald-500/30">
            <span class="text-[10px] font-mono uppercase text-emerald-400">Desk Cash Collections</span>
            <div class="text-xl font-mono font-bold text-emerald-400 mt-1" id="vchCollectedText">+ ₹3,500.00</div>
            <div class="text-[11px] text-slate-500 mt-1">From Walk-in Guest Receipts</div>
          </div>

          <div class="glass-card p-5 rounded-2xl border-rose-500/30">
            <span class="text-[10px] font-mono uppercase text-rose-400">Petty Cash Vouchers</span>
            <div class="text-xl font-mono font-bold text-rose-400 mt-1" id="vchVouchersText">- ₹800.00</div>
            <div class="text-[11px] text-slate-500 mt-1">Out-of-Pocket Expenses</div>
          </div>
        </div>

        <div class="flex justify-between items-center mb-4">
          <div>
            <h4 class="text-sm font-bold font-display text-white">Daily Out-of-Pocket Vouchers (Petty Cash Voucher System)</h4>
            <p class="text-xs text-slate-400">Expenses reviewed and reconciled with double-entry ledgers</p>
          </div>
          <button onclick="openVoucherModal()" class="px-3 py-1.5 rounded-lg bg-surface-200 hover:bg-surface-300 text-xs font-bold text-white border border-surface-border cursor-pointer">+ New Voucher</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-surface-100 text-slate-400 uppercase font-mono tracking-wider border-y border-white/5">
              <tr>
                <th class="py-3 px-4">Voucher ID</th>
                <th class="py-3 px-4">Category</th>
                <th class="py-3 px-4">Expense Description</th>
                <th class="py-3 px-4">Vendor</th>
                <th class="py-3 px-4">Time</th>
                <th class="py-3 px-4">Amount</th>
                <th class="py-3 px-4">Status</th>
                <th class="py-3 px-4 text-right">Manager Approval</th>
              </tr>
            </thead>
            <tbody id="adminVoucherTableBody" class="divide-y divide-white/5 font-medium"></tbody>
          </table>
        </div>
      </div>

      <!-- 3. STAFF COMPENSATION & CONTRACTS (4-AXIS DECOUPLING) TAB -->
      <div id="workStaffView" class="hidden p-6">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-surface-100 text-slate-400 uppercase font-mono tracking-wider border-y border-white/5">
              <tr>
                <th class="py-3 px-4" id="thStaffRoleHeader">Artisan Specialist</th>
                <th class="py-3 px-4">Title / Seniority</th>
                <th class="py-3 px-4">Experience</th>
                <th class="py-3 px-4">Certified Services</th>
                <th class="py-3 px-4" id="thSalary">Base Contract (Owner Only)</th>
                <th class="py-3 px-4" id="thCommission">Commission Cut</th>
                <th class="py-3 px-4">Realized Earnings</th>
              </tr>
            </thead>
            <tbody id="adminStaffTableBody" class="divide-y divide-white/5 font-medium"></tbody>
          </table>
        </div>
      </div>

    </div>

  </main>

  <!-- ========================================================================= -->
  <!-- MODALS: WALK-IN BOOKING & PETTY CASH VOUCHER                              -->
  <!-- ========================================================================= -->

  <!-- Modal 1: Walk-In POS -->
  <div id="walkinModal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
    <div class="glass-panel max-w-md w-full p-6 rounded-3xl border border-white/10 shadow-2xl">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-base font-bold font-display text-white">Front Desk Walk-In Booking</h3>
        <button onclick="closeWalkinModal()" class="text-slate-400 hover:text-white">✕</button>
      </div>

      <div class="space-y-3 text-xs">
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Client Full Name</label>
          <input type="text" id="walkinNameInput" placeholder="e.g. Maya Lin" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none focus:border-fuchsia-500">
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Mobile Number</label>
          <input type="tel" id="walkinPhoneInput" placeholder="e.g. 9811122334" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white font-mono focus:outline-none focus:border-fuchsia-500">
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Select Ritual / Service</label>
          <select id="walkinServiceSelect" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none"></select>
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Assign Certified Specialist</label>
          <select id="walkinStaffSelect" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none"></select>
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Time Window</label>
          <select id="walkinTimeSelect" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none">
            <option>01:00 PM</option>
            <option>02:30 PM</option>
            <option>04:00 PM</option>
            <option>05:30 PM</option>
          </select>
        </div>

        <button onclick="commitWalkin()" class="w-full bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-display font-bold py-3.5 rounded-xl uppercase tracking-wider mt-4 shadow-lg shadow-fuchsia-500/20 cursor-pointer">
          Confirm Appointment & Hold Station
        </button>
      </div>
    </div>
  </div>

  <!-- Modal 2: Petty Cash Voucher -->
  <div id="voucherModal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
    <div class="glass-panel max-w-md w-full p-6 rounded-3xl border border-white/10 shadow-2xl">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-base font-bold font-display text-white">Record Petty Cash Expense</h3>
        <button onclick="closeVoucherModal()" class="text-slate-400 hover:text-white">✕</button>
      </div>

      <div class="space-y-3 text-xs">
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Expense Category</label>
          <select id="vchCategory" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none">
            <option value="Client Hospitality">Client Hospitality (Tea / Coffee / Macarons)</option>
            <option value="Floor Supplies">Operational Supplies (Consumables & Essentials)</option>
            <option value="Errands">Local Courier / Transport</option>
            <option value="Sanitation">Sanitation & Maintenance Supplies</option>
          </select>
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Item Description</label>
          <input type="text" id="vchDesc" placeholder="e.g. Masala Chai & Biscotti for VIP Lounge" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none">
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Paid To (Vendor Name)</label>
          <input type="text" id="vchVendor" placeholder="e.g. Blue Tokai Coffee" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white focus:outline-none">
        </div>
        <div>
          <label class="block font-bold text-slate-400 mb-1 uppercase tracking-wider">Amount (₹ Cash Deducted from Drawer)</label>
          <input type="number" id="vchAmount" placeholder="250" class="w-full bg-surface-100 border border-surface-border rounded-xl p-3 text-white font-mono focus:outline-none">
        </div>

        <button onclick="commitVoucher()" class="w-full bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-display font-bold py-3.5 rounded-xl uppercase tracking-wider mt-4 shadow-lg shadow-rose-500/20 cursor-pointer">
          Post Voucher & Adjust Drawer Float
        </button>
      </div>
    </div>
  </div>


  <!-- ========================================================================= -->
  <!-- FRONTEND APPLICATION SCRIPT                                               -->
  <!-- ========================================================================= -->
  <script>
    const STORE = ${JSON.stringify(TENANTS_STORE)};
    let activeTenantKey = 'luxe-salon';
    let activeMode = 'client'; // 'client' or 'staff'
    let activeRole = 'OWNER';  // 'OWNER', 'MANAGER', 'RECEPTIONIST', 'STYLIST'

    // Client Wizard State
    let currService = null;
    let currStaff = null;
    let currDate = 'Fri, Nov 6';
    let currSlot = null;

    function getActiveTenant() {
      return STORE[activeTenantKey];
    }

    const TENANT_META = {
      'luxe-salon': { icon: '💇', label: 'Luxe Salon & Spa (Luxury)' },
      'iron-forge': { icon: '🏋️', label: 'Iron Forge Athletic Lab (Gym)' },
      'prana-yoga': { icon: '🧘', label: 'Prana Yoga Sanctuary (Wellness)' }
    };

    const ROLE_META = {
      'OWNER': { icon: '👑', label: 'Owner (Full P&L & Compensation)' },
      'MANAGER': { icon: '🏢', label: 'Branch Manager (Floor & Vouchers)' },
      'RECEPTIONIST': { icon: '🛎️', label: 'Front Desk Operator (POS Walk-in & Drawer)' },
      'FRONT_DESK_OPERATOR': { icon: '🛎️', label: 'Front Desk Operator (POS Walk-in & Drawer)' },
      'SERVICE_PROVIDER': { icon: '✂️', label: 'Service Provider (My Assigned Clients)' },
      'STYLIST': { icon: '✂️', label: 'Service Provider (My Assigned Clients)' }
    };

    function getRoleMeta(role, tenant) {
      const t = tenant || getActiveTenant();
      if (role === 'SERVICE_PROVIDER' || role === 'STYLIST') {
        const pr = t.professionalRole;
        return {
          icon: pr.icon,
          label: pr.shortTitle + ' (' + pr.scopeLabel + ')'
        };
      }
      return ROLE_META[role] || ROLE_META['OWNER'];
    }

    function toggleTenantDropdown(e) {
      if (e) e.stopPropagation();
      closeRoleDropdown();
      const menu = document.getElementById('tenantDropdownMenu');
      const chevron = document.getElementById('tenantChevron');
      const isOpen = !menu.classList.contains('hidden');
      if (isOpen) {
        closeTenantDropdown();
      } else {
        menu.classList.remove('hidden');
        if (chevron) chevron.classList.add('rotate-180');
      }
    }

    function closeTenantDropdown() {
      const menu = document.getElementById('tenantDropdownMenu');
      const chevron = document.getElementById('tenantChevron');
      if (menu) menu.classList.add('hidden');
      if (chevron) chevron.classList.remove('rotate-180');
    }

    function selectTenant(key) {
      closeTenantDropdown();
      changeTenant(key);
    }

    function toggleRoleDropdown(e) {
      if (e) e.stopPropagation();
      closeTenantDropdown();
      const menu = document.getElementById('roleDropdownMenu');
      const chevron = document.getElementById('roleChevron');
      const isOpen = !menu.classList.contains('hidden');
      if (isOpen) {
        closeRoleDropdown();
      } else {
        menu.classList.remove('hidden');
        if (chevron) chevron.classList.add('rotate-180');
      }
    }

    function closeRoleDropdown() {
      const menu = document.getElementById('roleDropdownMenu');
      const chevron = document.getElementById('roleChevron');
      if (menu) menu.classList.add('hidden');
      if (chevron) chevron.classList.remove('rotate-180');
    }

    function selectRole(role) {
      closeRoleDropdown();
      changeRole(role);
    }

    // Global click listener to close custom dropdowns when clicking outside
    document.addEventListener('click', function(e) {
      const tDrop = document.getElementById('customTenantDropdown');
      const rDrop = document.getElementById('customRoleDropdown');
      if (tDrop && !tDrop.contains(e.target)) closeTenantDropdown();
      if (rDrop && !rDrop.contains(e.target)) closeRoleDropdown();
    });

    // Tenant Switcher
    function changeTenant(key) {
      activeTenantKey = key;
      const t = getActiveTenant();

      const meta = TENANT_META[key] || TENANT_META['luxe-salon'];
      const iconEl = document.getElementById('selectedTenantIcon');
      const labelEl = document.getElementById('selectedTenantLabel');
      if (iconEl) iconEl.textContent = meta.icon;
      if (labelEl) labelEl.textContent = meta.label;

      // Dynamically update the Role Dropdown for this tenant's professional title
      const pr = t.professionalRole;
      const rItemIcon = document.getElementById('roleItemProviderIcon');
      const rItemTitle = document.getElementById('roleItemProviderTitle');
      const rItemDesc = document.getElementById('roleItemProviderDesc');
      if (rItemIcon) rItemIcon.textContent = pr.icon;
      if (rItemTitle) rItemTitle.textContent = pr.title;
      if (rItemDesc) rItemDesc.textContent = pr.description;

      // If SERVICE_PROVIDER role is currently active, update button label & role badge
      if (activeRole === 'SERVICE_PROVIDER' || activeRole === 'STYLIST') {
        const rMeta = getRoleMeta(activeRole, t);
        const rIconEl = document.getElementById('selectedRoleIcon');
        const rLabelEl = document.getElementById('selectedRoleLabel');
        if (rIconEl) rIconEl.textContent = rMeta.icon;
        if (rLabelEl) rLabelEl.textContent = rMeta.label;
        document.getElementById('badgeRoleTitle').textContent = 'ROLE: ' + pr.shortTitle.toUpperCase();
      }

      // Update Client Booking Wizard Step 2 labels
      const s2Label = document.getElementById('step2IndicatorLabel');
      const s2Heading = document.getElementById('step2Heading');
      const s2Sub = document.getElementById('step2Subheading');
      if (s2Label) s2Label.textContent = pr.shortTitle;
      if (s2Heading) s2Heading.textContent = pr.wizardTitle;
      if (s2Sub) s2Sub.textContent = pr.wizardSubtitle;

      // Update Staff Table Header
      const thStaffRole = document.getElementById('thStaffRoleHeader');
      if (thStaffRole) thStaffRole.textContent = pr.title;

      document.getElementById('heroTitle').textContent = t.name;
      document.getElementById('heroTagline').textContent = t.tagline;
      document.getElementById('heroBranch').textContent = t.branch;
      document.getElementById('heroBadge').textContent = t.vertical.toUpperCase();
      document.getElementById('adminBranchText').textContent = t.branch;

      navStep(1);
      renderServiceCards();
      renderStaffSelector();
      renderAdminViews();
    }

    // Portal Switcher
    function switchView(mode) {
      activeMode = mode;
      const clientView = document.getElementById('clientViewContainer');
      const staffView = document.getElementById('staffViewContainer');
      const roleWidget = document.getElementById('roleSelectorWidget');
      const btnClient = document.getElementById('btnClientPortal');
      const btnStaff = document.getElementById('btnStaffPortal');

      if (mode === 'client') {
        clientView.classList.remove('hidden');
        staffView.classList.add('hidden');
        roleWidget.classList.add('hidden');
        btnClient.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 bg-gradient-to-r from-fuchsia-600 to-violet-600 text-white shadow-lg shadow-fuchsia-500/25';
        btnStaff.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 text-slate-400 hover:text-white';
      } else {
        clientView.classList.add('hidden');
        staffView.classList.remove('hidden');
        roleWidget.classList.remove('hidden');
        btnStaff.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/25';
        btnClient.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 text-slate-400 hover:text-white';
        renderAdminViews();
      }
    }

    // Role Switcher (Zero-Trust Field Redaction Simulation)
    function changeRole(role) {
      activeRole = role;
      const t = getActiveTenant();
      const meta = getRoleMeta(role, t);

      const roleBadgeTitle = (role === 'SERVICE_PROVIDER' || role === 'STYLIST') ? t.professionalRole.shortTitle.toUpperCase() : role;
      document.getElementById('badgeRoleTitle').textContent = 'ROLE: ' + roleBadgeTitle;

      const iconEl = document.getElementById('selectedRoleIcon');
      const labelEl = document.getElementById('selectedRoleLabel');
      if (iconEl) iconEl.textContent = meta.icon;
      if (labelEl) labelEl.textContent = meta.label;

      const cardRev = document.getElementById('kpiRevenueCard');
      const cardDrawer = document.getElementById('kpiDrawerCard');
      const thSalary = document.getElementById('thSalary');
      const thCommission = document.getElementById('thCommission');
      const btnQuickVoucher = document.getElementById('btnQuickVoucher');

      if (role === 'SERVICE_PROVIDER' || role === 'STYLIST') {
        cardRev.style.display = 'none';
        cardDrawer.style.display = 'none';
        thSalary.style.display = 'none';
        thCommission.style.display = 'none';
        btnQuickVoucher.style.display = 'none';
      } else if (role === 'RECEPTIONIST') {
        cardRev.style.display = 'block';
        cardDrawer.style.display = 'block';
        thSalary.style.display = 'none'; // Front Desk Operator cannot see base salaries
        thCommission.style.display = 'none';
        btnQuickVoucher.style.display = 'inline-flex';
      } else {
        cardRev.style.display = 'block';
        cardDrawer.style.display = 'block';
        thSalary.style.display = (role === 'OWNER') ? 'table-cell' : 'none';
        thCommission.style.display = 'table-cell';
        btnQuickVoucher.style.display = 'inline-flex';
      }

      renderAdminViews();
    }

    // Render Client Services
    function renderServiceCards() {
      const t = getActiveTenant();
      const container = document.getElementById('servicesGrid');
      container.innerHTML = '';

      t.services.forEach(s => {
        const card = document.createElement('div');
        card.className = 'glass-card rounded-2xl p-5 flex flex-col justify-between group';
        card.innerHTML = \`
          <div>
            <div class="h-44 w-full rounded-xl overflow-hidden mb-4 bg-obsidian relative">
              <img src="\${s.image}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
              <span class="absolute top-2.5 right-2.5 bg-obsidian/80 backdrop-blur-md text-[10px] font-mono text-emerald-400 font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">
                \${s.rating}
              </span>
            </div>
            <div class="flex items-center justify-between text-xs mb-1">
              <span class="text-fuchsia-400 font-bold uppercase tracking-wider text-[10px]">\${s.category}</span>
              <span class="text-slate-400 font-mono">\${s.duration} mins</span>
            </div>
            <h3 class="font-bold text-white text-base leading-snug group-hover:text-fuchsia-300 transition-colors">\${s.name}</h3>
            <p class="text-xs text-slate-400 mt-1 line-clamp-2 font-light leading-relaxed">\${s.description}</p>
          </div>

          <div class="flex justify-between items-center mt-5 pt-4 border-t border-white/5">
            <div>
              <span class="text-[9px] uppercase font-mono text-slate-400 block">Total</span>
              <span class="font-mono text-base font-bold text-white">₹\${s.price.toLocaleString('en-IN')}</span>
            </div>
            <button onclick="selectService('\${s.id}')" class="px-4 py-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-display font-bold text-xs shadow-md shadow-fuchsia-500/20 transition-all cursor-pointer">
              Reserve →
            </button>
          </div>
        \`;
        container.appendChild(card);
      });
    }

    function selectService(id) {
      const t = getActiveTenant();
      currService = t.services.find(s => s.id === id);
      renderStaffSelector();
      navStep(2);
    }

    // Render Service Provider Selector
    function renderStaffSelector() {
      const t = getActiveTenant();
      const container = document.getElementById('staffGrid');
      container.innerHTML = '';

      // Any available option
      const anyCard = document.createElement('div');
      anyCard.className = 'glass-card rounded-2xl p-6 text-center cursor-pointer flex flex-col items-center justify-center';
      anyCard.innerHTML = \`
        <div class="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-xl text-fuchsia-400 mb-3">★</div>
        <h4 class="font-bold text-sm text-white">First Available Artisan</h4>
        <span class="text-[11px] text-slate-400 mt-1">Recommended for quickest slot allocation</span>
        <button onclick="selectStaff(null)" class="mt-4 px-4 py-1.5 rounded-lg bg-surface-200 hover:bg-fuchsia-600 text-white text-xs font-bold transition-all">Select</button>
      \`;
      container.appendChild(anyCard);

      // Certified specialists
      t.staff.filter(st => !currService || st.certified.includes(currService.id)).forEach(st => {
        const card = document.createElement('div');
        card.className = 'glass-card rounded-2xl p-6 text-center cursor-pointer flex flex-col items-center justify-center';
        card.innerHTML = \`
          <img src="\${st.avatar}" class="w-16 h-16 rounded-2xl object-cover mb-3 ring-2 ring-fuchsia-500/40 shadow-lg">
          <h4 class="font-bold text-sm text-white">\${st.name}</h4>
          <span class="text-[11px] text-fuchsia-400 font-semibold">\${st.title}</span>
          <span class="text-[10px] text-slate-400 font-mono mt-0.5">\${st.experience} experience</span>
          <button onclick="selectStaff('\${st.id}')" class="mt-4 px-4 py-1.5 rounded-lg bg-surface-200 hover:bg-fuchsia-600 text-white text-xs font-bold transition-all">Select</button>
        \`;
        container.appendChild(card);
      });
    }

    function selectStaff(id) {
      const t = getActiveTenant();
      currStaff = id ? t.staff.find(st => st.id === id) : t.staff[0];
      navStep(3);
    }

    function chooseDate(el, date) {
      document.querySelectorAll('.date-chip').forEach(b => {
        b.className = 'date-chip bg-surface-100 hover:bg-surface-200 border border-surface-border py-3 rounded-xl text-center font-bold text-xs text-slate-300';
      });
      el.className = 'date-chip bg-fuchsia-600/20 border border-fuchsia-500 text-fuchsia-300 py-3 rounded-xl text-center font-bold text-xs';
      currDate = date;
    }

    function chooseSlot(el, slot) {
      document.querySelectorAll('.slot-chip').forEach(b => {
        b.className = 'slot-chip bg-surface-100 hover:border-fuchsia-500/50 border border-surface-border py-3 rounded-xl text-center font-mono text-xs font-semibold text-slate-200';
      });
      el.className = 'slot-chip bg-fuchsia-600 border border-fuchsia-400 py-3 rounded-xl text-center font-mono text-xs font-bold text-white shadow-lg shadow-fuchsia-500/30';
      currSlot = slot;

      const btn = document.getElementById('btnProceedToGuest');
      btn.disabled = false;
      btn.textContent = 'Continue with ' + slot + ' →';
      btn.className = 'w-full bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white py-3.5 rounded-xl font-display font-bold text-xs uppercase tracking-wider cursor-pointer transition-all shadow-lg shadow-fuchsia-500/25';
    }

    function navStep(step) {
      [1, 2, 3, 4, 5].forEach(s => {
        const card = document.getElementById('step' + s + 'Card');
        if (card) card.classList.add('hidden');
        const ind = document.getElementById('step' + s + 'Ind');
        if (ind) {
          ind.className = (s === step) ? 'flex items-center gap-2 text-fuchsia-400' : 'flex items-center gap-2 text-slate-500';
        }
      });

      const targetCard = document.getElementById('step' + step + 'Card');
      if (targetCard) targetCard.classList.remove('hidden');

      if (step === 4) {
        document.getElementById('ticketServiceCat').textContent = currService.category;
        document.getElementById('ticketServiceName').textContent = currService.name;
        document.getElementById('ticketStaffName').textContent = currStaff ? currStaff.name : 'First Available';
        document.getElementById('ticketPrice').textContent = '₹' + currService.price.toLocaleString('en-IN');
        document.getElementById('ticketSlotTime').textContent = currDate + ' • ' + currSlot;
      }
    }

    function formatPhoneRealtime(val) {
      const pill = document.getElementById('phoneNormalizedPill');
      let cleaned = val.replace(/[\\s\\-\\(\\)]/g, '');
      if (!cleaned.startsWith('+')) {
        if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
        cleaned = '+91' + cleaned;
      }
      pill.innerHTML = \`<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> <span>E.164: \${cleaned} (Validated)</span>\`;
    }

    function triggerOTP() {
      document.getElementById('otpDrawer').classList.remove('hidden');
      document.getElementById('btnSendOTP').classList.add('hidden');
      document.getElementById('btnConfirmReservation').classList.remove('hidden');
    }

    function sealReservation() {
      const t = getActiveTenant();
      const guestName = document.getElementById('guestNameInput').value;
      const guestPhone = document.getElementById('guestPhoneInput').value;
      const aptId = 'APT-' + Math.floor(1000 + Math.random() * 9000);

      const newApt = {
        id: aptId,
        customer: guestName,
        phone: '+91 ' + guestPhone.replace(/\\D/g, '').slice(-10),
        service: currService.name,
        staff: currStaff ? currStaff.name : t.staff[0].name,
        time: currSlot,
        status: 'CONFIRMED',
        price: currService.price,
        payment: 'DUE_AT_DESK',
        tender: 'Due at checkout'
      };
      t.appointments.unshift(newApt);

      document.getElementById('finalTicketId').textContent = aptId;
      document.getElementById('finalServiceName').textContent = currService.name;
      document.getElementById('finalStaffName').textContent = newApt.staff;
      document.getElementById('finalSlotTime').textContent = currDate + ' • ' + currSlot;
      document.getElementById('finalGuestName').textContent = guestName;
      document.getElementById('finalPrice').textContent = '₹' + currService.price.toLocaleString('en-IN');

      navStep(5);
    }

    // Admin Workplace Views (Schedule, Drawer, Staff)
    function renderAdminViews() {
      const t = getActiveTenant();

      // KPIs
      const realizedRevenue = t.appointments.filter(a => a.payment === 'PAID').reduce((sum, a) => sum + a.price, 0);
      document.getElementById('kpiGrossRev').textContent = '₹' + realizedRevenue.toLocaleString('en-IN');
      document.getElementById('kpiAptCount').textContent = t.appointments.length;
      const expectedCash = t.drawer.openingFloat + t.drawer.cashCollected - t.drawer.vouchers.reduce((sum, v) => sum + v.amount, 0);
      document.getElementById('kpiDrawerCash').textContent = '₹' + expectedCash.toLocaleString('en-IN');

      // 1. Appointments Table
      const aptBody = document.getElementById('adminAptTableBody');
      aptBody.innerHTML = '';

      let list = t.appointments;
      if (activeRole === 'SERVICE_PROVIDER' || activeRole === 'STYLIST') {
        const primaryStaffName = t.staff[0].name.split(' ')[0];
        list = t.appointments.filter(a => a.staff.includes(primaryStaffName));
      }

      list.forEach(a => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.02] transition-colors';
        const stClass = a.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                        a.status === 'IN_SERVICE' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' :
                        'bg-amber-500/10 text-amber-400 border-amber-500/30';

        tr.innerHTML = \`
          <td class="py-3.5 px-4 font-mono font-bold text-white">\${a.time}</td>
          <td class="py-3.5 px-4"><div>\${a.customer}</div><div class="text-[10px] text-slate-500 font-mono">\${a.phone}</div></td>
          <td class="py-3.5 px-4 text-slate-200 font-medium">\${a.service}</td>
          <td class="py-3.5 px-4 text-slate-300">\${a.staff}</td>
          <td class="py-3.5 px-4 font-mono text-white font-bold">₹\${a.price.toLocaleString('en-IN')}</td>
          <td class="py-3.5 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold border \${stClass}">\${a.status}</span></td>
          <td class="py-3.5 px-4">
            <span class="text-[11px] font-semibold text-slate-300 block">\${a.payment}</span>
            <span class="text-[10px] text-slate-500 font-mono">\${a.tender}</span>
          </td>
          <td class="py-3.5 px-4 text-right">
            \${a.payment !== 'PAID' ? 
              \`<button onclick="posCheckout('\${a.id}')" class="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-white font-mono font-bold text-[10px] border border-emerald-500/40 transition-all cursor-pointer">POS Settle</button>\` : 
              \`<span class="text-slate-500 text-[11px]">✓ Settled</span>\`}
          </td>
        \`;
        aptBody.appendChild(tr);
      });

      // 2. Vouchers & Drawer
      document.getElementById('vchFloatText').textContent = '₹' + t.drawer.openingFloat.toLocaleString('en-IN') + '.00';
      document.getElementById('vchCollectedText').textContent = '+ ₹' + t.drawer.cashCollected.toLocaleString('en-IN') + '.00';
      const vchTotal = t.drawer.vouchers.reduce((sum, v) => sum + v.amount, 0);
      document.getElementById('vchVouchersText').textContent = '- ₹' + vchTotal.toLocaleString('en-IN') + '.00';

      const vchBody = document.getElementById('adminVoucherTableBody');
      vchBody.innerHTML = '';
      t.drawer.vouchers.forEach(v => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.02] transition-colors';
        tr.innerHTML = \`
          <td class="py-3.5 px-4 font-mono font-bold text-fuchsia-400">\${v.id}</td>
          <td class="py-3.5 px-4"><span class="bg-surface-200 text-slate-300 px-2 py-0.5 rounded text-[10px] font-semibold">\${v.category}</span></td>
          <td class="py-3.5 px-4 text-white font-medium">\${v.desc}</td>
          <td class="py-3.5 px-4 text-slate-400">\${v.paidTo}</td>
          <td class="py-3.5 px-4 text-slate-500 font-mono">\${v.time}</td>
          <td class="py-3.5 px-4 font-mono font-bold text-rose-400">- ₹\${v.amount}</td>
          <td class="py-3.5 px-4"><span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded text-[10px] font-bold">\${v.status}</span></td>
          <td class="py-3.5 px-4 text-right">
            \${v.status === 'PROVISIONAL' && (activeRole === 'OWNER' || activeRole === 'MANAGER') ? 
              \`<button onclick="approveVoucher('\${v.id}')" class="px-2.5 py-1 rounded bg-emerald-500 text-white font-bold text-[10px] cursor-pointer">Approve</button>\` : 
              \`<span class="text-slate-500 text-[11px]">Approved</span>\`}
          </td>
        \`;
        vchBody.appendChild(tr);
      });

      // 3. Staff & 4-Axis Contracts
      const stfBody = document.getElementById('adminStaffTableBody');
      stfBody.innerHTML = '';
      t.staff.forEach(st => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.02] transition-colors';
        const certNames = st.certified.map(sid => {
          const s = t.services.find(svc => svc.id === sid);
          return s ? s.name : sid;
        }).join(', ');

        const showSalary = (activeRole === 'OWNER');
        const showComm = (activeRole !== 'SERVICE_PROVIDER' && activeRole !== 'STYLIST');

        tr.innerHTML = \`
          <td class="py-3.5 px-4 flex items-center gap-3">
            <img src="\${st.avatar}" class="w-8 h-8 rounded-xl object-cover ring-1 ring-white/10">
            <span class="font-bold text-white">\${st.name}</span>
          </td>
          <td class="py-3.5 px-4 text-slate-300 font-medium">\${st.title}</td>
          <td class="py-3.5 px-4 font-mono text-slate-400">\${st.experience}</td>
          <td class="py-3.5 px-4 text-slate-400 text-[11px] max-w-xs truncate">\${certNames}</td>
          \${showSalary ? \`<td class="py-3.5 px-4 font-mono text-white font-bold">\${st.baseSalary}</td>\` : (activeRole === 'OWNER' ? '<td></td>' : '')}
          \${showComm ? \`<td class="py-3.5 px-4 font-mono text-violet-400 font-bold">\${st.commission}</td>\` : ''}
          <td class="py-3.5 px-4 font-mono font-bold text-emerald-400">\${st.todayEarnings}</td>
        \`;
        stfBody.appendChild(tr);
      });
    }

    function switchWorkTab(tab) {
      ['schedule', 'drawer', 'staff'].forEach(t => {
        document.getElementById('work' + t.charAt(0).toUpperCase() + t.slice(1) + 'View').classList.add('hidden');
        document.getElementById('workTab' + t.charAt(0).toUpperCase() + t.slice(1)).className = 'pb-4 border-b-2 border-transparent text-slate-400 hover:text-white flex items-center gap-2';
      });

      document.getElementById('work' + tab.charAt(0).toUpperCase() + tab.slice(1) + 'View').classList.remove('hidden');
      document.getElementById('workTab' + tab.charAt(0).toUpperCase() + tab.slice(1)).className = 'pb-4 border-b-2 border-fuchsia-500 text-fuchsia-400 flex items-center gap-2';
    }

    function posCheckout(id) {
      const t = getActiveTenant();
      const apt = t.appointments.find(a => a.id === id);
      if (apt) {
        const cashPortion = 1000;
        const upiPortion = apt.price - cashPortion;
        apt.payment = 'PAID';
        apt.status = 'COMPLETED';
        apt.tender = 'Split: Cash (₹' + cashPortion.toLocaleString('en-IN') + ') + UPI (₹' + upiPortion.toLocaleString('en-IN') + ')';
        t.drawer.cashCollected += cashPortion;
        renderAdminViews();
      }
    }

    function openWalkinModal() {
      const t = getActiveTenant();
      const sSelect = document.getElementById('walkinServiceSelect');
      const stSelect = document.getElementById('walkinStaffSelect');
      sSelect.innerHTML = '';
      stSelect.innerHTML = '';
      t.services.forEach(s => sSelect.innerHTML += \`<option value="\${s.id}">\${s.name} (₹\${s.price})</option>\`);
      t.staff.forEach(st => stSelect.innerHTML += \`<option value="\${st.name}">\${st.name}</option>\`);
      document.getElementById('walkinModal').classList.remove('hidden');
    }
    function closeWalkinModal() { document.getElementById('walkinModal').classList.add('hidden'); }
    function commitWalkin() {
      const t = getActiveTenant();
      const name = document.getElementById('walkinNameInput').value || 'Walk-in Client';
      const phone = document.getElementById('walkinPhoneInput').value || '9811199988';
      const sId = document.getElementById('walkinServiceSelect').value;
      const s = t.services.find(svc => svc.id === sId);
      const staffName = document.getElementById('walkinStaffSelect').value;
      const time = document.getElementById('walkinTimeSelect').value;

      t.appointments.unshift({
        id: 'APT-' + Math.floor(1000 + Math.random() * 9000),
        customer: name,
        phone: '+91 ' + phone.replace(/\\D/g, '').slice(-10),
        service: s.name,
        staff: staffName,
        time: time,
        status: 'CONFIRMED',
        price: s.price,
        payment: 'DUE_AT_DESK',
        tender: 'Due at checkout'
      });
      closeWalkinModal();
      renderAdminViews();
    }

    function openVoucherModal() { document.getElementById('voucherModal').classList.remove('hidden'); }
    function closeVoucherModal() { document.getElementById('voucherModal').classList.add('hidden'); }
    function commitVoucher() {
      const t = getActiveTenant();
      const cat = document.getElementById('vchCategory').value;
      const desc = document.getElementById('vchDesc').value || 'Store Expense';
      const paidTo = document.getElementById('vchVendor').value || 'Local Vendor';
      const amount = Number(document.getElementById('vchAmount').value) || 200;

      t.drawer.vouchers.unshift({
        id: 'VCH-' + Math.floor(10 + Math.random() * 90),
        category: cat,
        desc: desc,
        amount: amount,
        paidTo: paidTo,
        time: '12:30 PM',
        status: (activeRole === 'OWNER' || activeRole === 'MANAGER') ? 'APPROVED' : 'PROVISIONAL'
      });
      closeVoucherModal();
      renderAdminViews();
    }

    function approveVoucher(id) {
      const t = getActiveTenant();
      const v = t.drawer.vouchers.find(vch => vch.id === id);
      if (v) {
        v.status = 'APPROVED';
        renderAdminViews();
      }
    }

    // Initialize Luxe Salon & Spa
    changeTenant('luxe-salon');
  </script>
</body>
</html>`;
}

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Web Application Root
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/book' || url.pathname === '/admin')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHTML());
    return;
  }

  // API Health
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', service: 'atelier-ui' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n================================================================`);
  console.log(`  ATELIER WEB3 GLASS UI ONLINE AT: http://localhost:${PORT}`);
  console.log(`================================================================\n`);
});
