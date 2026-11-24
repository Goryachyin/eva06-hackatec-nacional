export interface StudyItem {
  code: string;
  name: string;
  category: string;
  price: number;
  prep: string;
}

export interface ClinicItem {
  id: string;
  name: string;
  city: string;
  address: string;
  hours: string;
}

export const STUDIES_CATALOG: StudyItem[] = [
  {
    code: "US-OBS",
    name: "Ultrasonido Obstétrico",
    category: "Ultrasonido",
    price: 320,
    prep: "No requiere ayuno. Acudir con ropa cómoda de dos piezas.",
  },
  {
    code: "US-ABD",
    name: "Ultrasonido Abdominal Completo",
    category: "Ultrasonido",
    price: 360,
    prep: "Requiere ayuno de 8 horas previas al estudio.",
  },
  {
    code: "LAB-BH",
    name: "Biometría Hemática Completa",
    category: "Laboratorio",
    price: 110,
    prep: "Ayuno mínimo de 4 horas recomendado.",
  },
  {
    code: "LAB-QS6",
    name: "Química Sanguínea de 6 Elementos",
    category: "Laboratorio",
    price: 195,
    prep: "Requiere ayuno estricto de 8 a 12 horas (solo agua natural).",
  },
  {
    code: "ECG-BAS",
    name: "Electrocardiograma en Reposo",
    category: "Cardiología",
    price: 150,
    prep: "No aplicar cremas o aceites en el pecho el día del estudio.",
  },
  {
    code: "IMG-MAST",
    name: "Mastografía Bilateral",
    category: "Imagenología",
    price: 295,
    prep: "Acudir sin desodorante, talco ni crema en axilas o pecho.",
  },
];

export const CLINICS_CATALOG: ClinicItem[] = [
  {
    id: "CLN-CUL-01",
    name: "Salud Digna Culiacán Centro",
    city: "Culiacán, Sinaloa",
    address: "Av. Álvaro Obregón 480 Sur, Col. Centro",
    hours: "Lun–Vie 06:30–19:00 · Sáb 06:30–17:00",
  },
  {
    id: "CLN-GDL-01",
    name: "Salud Digna Guadalajara Chapultepec",
    city: "Guadalajara, Jalisco",
    address: "Av. Chapultepec Sur 214, Col. Americana",
    hours: "Lun–Vie 06:00–19:00 · Sáb 06:30–17:00",
  },
  {
    id: "CLN-CDMX-01",
    name: "Salud Digna CDMX Roma",
    city: "Ciudad de México",
    address: "Av. Monterrey 142, Col. Roma Norte",
    hours: "Lun–Vie 06:00–19:00 · Sáb 06:30–17:00",
  },
  {
    id: "CLN-MTY-01",
    name: "Salud Digna Monterrey Obispado",
    city: "Monterrey, Nuevo León",
    address: "Av. Miguel Hidalgo 1910, Col. Obispado",
    hours: "Lun–Vie 06:30–19:00 · Sáb 06:30–17:00",
  },
];

export function findStudyByCode(code: string): StudyItem | undefined {
  return STUDIES_CATALOG.find((s) => s.code.toUpperCase() === code.toUpperCase());
}

export function findClinicById(id: string): ClinicItem | undefined {
  return CLINICS_CATALOG.find((c) => c.id.toUpperCase() === id.toUpperCase());
}
