-- Esquema del Sistema de Control de Retenciones
-- Los importes se guardan en centésimos (enteros) para evitar errores de redondeo.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entidades (
  id      INTEGER PRIMARY KEY,
  nombre  TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(nombre)) > 0),
  tipo    TEXT NOT NULL CHECK (tipo IN ('judicial', 'comercial'))
);

CREATE TABLE IF NOT EXISTS colaboradores (
  id      INTEGER PRIMARY KEY,
  cedula  TEXT NOT NULL UNIQUE CHECK (cedula GLOB '[0-9]*' AND length(cedula) BETWEEN 6 AND 8),
  nombre  TEXT NOT NULL CHECK (length(trim(nombre)) > 0)
);

CREATE TABLE IF NOT EXISTS empresas (
  id      INTEGER PRIMARY KEY,
  nombre  TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(nombre)) > 0)
);

CREATE TABLE IF NOT EXISTS retenciones (
  id             INTEGER PRIMARY KEY,
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE RESTRICT,
  entidad_id     INTEGER NOT NULL REFERENCES entidades(id) ON DELETE RESTRICT,
  periodo        TEXT NOT NULL CHECK (periodo GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  importe_total  INTEGER NOT NULL CHECK (importe_total > 0),
  concepto       TEXT NOT NULL DEFAULT '',
  expediente     TEXT NOT NULL DEFAULT '',
  beneficiario   TEXT,
  cargado_por    TEXT NOT NULL CHECK (length(trim(cargado_por)) > 0),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS ix_retenciones_periodo ON retenciones(periodo);
CREATE INDEX IF NOT EXISTS ix_retenciones_colaborador ON retenciones(colaborador_id);

CREATE TABLE IF NOT EXISTS descuentos (
  id             INTEGER PRIMARY KEY,
  retencion_id   INTEGER NOT NULL REFERENCES retenciones(id) ON DELETE RESTRICT,
  importe        INTEGER NOT NULL CHECK (importe > 0),
  tipo           TEXT NOT NULL CHECK (tipo IN ('1Q', '2Q', 'Egresos', 'Ajustes', 'Licencias')),
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  descontado_por TEXT NOT NULL CHECK (length(trim(descontado_por)) > 0),
  fecha          TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS ix_descuentos_retencion ON descuentos(retencion_id);

-- ── Regla de oro: nunca se descuenta más que el importe total de la retención ──

CREATE TRIGGER IF NOT EXISTS tr_descuentos_tope_insert
BEFORE INSERT ON descuentos
WHEN NEW.importe + COALESCE((SELECT SUM(importe) FROM descuentos WHERE retencion_id = NEW.retencion_id), 0)
     > (SELECT importe_total FROM retenciones WHERE id = NEW.retencion_id)
BEGIN
  SELECT RAISE(ABORT, 'TOPE_EXCEDIDO');
END;

CREATE TRIGGER IF NOT EXISTS tr_descuentos_tope_update
BEFORE UPDATE OF importe, retencion_id ON descuentos
WHEN NEW.importe + COALESCE((SELECT SUM(importe) FROM descuentos
                             WHERE retencion_id = NEW.retencion_id AND id <> OLD.id), 0)
     > (SELECT importe_total FROM retenciones WHERE id = NEW.retencion_id)
BEGIN
  SELECT RAISE(ABORT, 'TOPE_EXCEDIDO');
END;

CREATE TRIGGER IF NOT EXISTS tr_retenciones_total_update
BEFORE UPDATE OF importe_total ON retenciones
WHEN NEW.importe_total < COALESCE((SELECT SUM(importe) FROM descuentos WHERE retencion_id = NEW.id), 0)
BEGIN
  SELECT RAISE(ABORT, 'TOTAL_MENOR_A_DESCONTADO');
END;

-- ── El beneficiario es obligatorio cuando la entidad es judicial ──

CREATE TRIGGER IF NOT EXISTS tr_retenciones_beneficiario_insert
BEFORE INSERT ON retenciones
WHEN (SELECT tipo FROM entidades WHERE id = NEW.entidad_id) = 'judicial'
     AND (NEW.beneficiario IS NULL OR length(trim(NEW.beneficiario)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'BENEFICIARIO_OBLIGATORIO');
END;

CREATE TRIGGER IF NOT EXISTS tr_retenciones_beneficiario_update
BEFORE UPDATE OF entidad_id, beneficiario ON retenciones
WHEN (SELECT tipo FROM entidades WHERE id = NEW.entidad_id) = 'judicial'
     AND (NEW.beneficiario IS NULL OR length(trim(NEW.beneficiario)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'BENEFICIARIO_OBLIGATORIO');
END;
