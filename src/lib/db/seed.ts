// Datos de arranque para un usuario nuevo (Rienda + Sheets).
// Categorías y subcategorías: las de Renzo al 18/10/2026. El usuario las edita
// después en Configuración. NO incluye el perfil (lo crea la bienvenida) ni datos
// personales. Se ejecuta al crear el perfil, una sola vez.

export const SEED_BASE = `
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Viajes', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Alimentación', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Transporte', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Ocio y tiempo libre', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Ahorro', 1);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Salud y bienestar', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Regalos y social', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Vivienda', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Suscripciones', 0);
INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Compras y personales', 0);

INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Otros (en destino)', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Restaurantes y salidas', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Supermercado', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Transporte público', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'App de movilidad', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Piano', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Café y meriendas', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'DIA', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'SPY', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Médicos y farmacia', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Regalos', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Gaming y hobbies', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Empleada doméstica', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Apps y plataformas', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Tecnología', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Estética', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Productividad', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Streaming', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Comida', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Alojamiento', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Transporte', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Ropa y accesorios', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Seguros', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Psicólogo', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Hogar', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Deportes', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Restante', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Balanz', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Salidas y entretenimiento', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Delivery', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Gimnasio', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Viaje', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Sueldo 30%', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Otros', 0);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Meta ahorro', 1);
INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Cocos', 0);

-- Tarjeta genérica de arranque: habilita el flujo de crédito de entrada. El
-- usuario la renombra o agrega más en Configuración.
INSERT INTO tarjeta (perfil_id, nombre, tipo) VALUES (1, 'Genérica', 'credito');
`;
