// In-memory Supabase mock that simulates the PostgREST query builder pattern.
// The real Supabase client builds queries via chaining, then resolves them.
// This mock stores data in memory and resolves queries synchronously.

function createMockSupabase() {
  const store = {};
  const idCounters = {};

  function ensureTable(table) {
    if (!store[table]) store[table] = [];
  }

  function nextId(table) {
    if (!idCounters[table]) idCounters[table] = 1;
    return idCounters[table]++;
  }

  function createQueryBuilder(table) {
    ensureTable(table);

    let operation = 'select';
    let operationData = null;
    let filters = [];
    let orderCols = [];
    let limitVal = null;
    let singleMode = false;
    let maybeSingleMode = false;
    let selectOpts = {};

    function resolve() {
      if (operation === 'select') {
        let rows = [...store[table]];
        for (const f of filters) rows = rows.filter(f);
        for (const { col, ascending } of orderCols) {
          rows.sort((a, b) => {
            if (a[col] < b[col]) return ascending ? -1 : 1;
            if (a[col] > b[col]) return ascending ? 1 : -1;
            return 0;
          });
        }
        if (limitVal !== null) rows = rows.slice(0, limitVal);

        if (selectOpts.count === 'exact' && selectOpts.head) {
          return { count: rows.length, error: null };
        }
        if (singleMode) {
          if (rows.length === 0) return { data: null, error: { message: 'No rows found' } };
          return { data: { ...rows[0] }, error: null };
        }
        if (maybeSingleMode) {
          return { data: rows.length > 0 ? { ...rows[0] } : null, error: null };
        }
        return { data: rows.map(r => ({ ...r })), error: null };
      }

      if (operation === 'insert') {
        const row = { ...operationData };
        if (row.id === undefined) row.id = nextId(table);
        if (!row.created_at) row.created_at = new Date().toISOString();
        store[table].push(row);
        // Returns are handled by the select/single chain below
        return { _insertedRow: row };
      }

      if (operation === 'update') {
        let rows = [...store[table]];
        for (const f of filters) rows = rows.filter(f);
        for (const row of rows) {
          const idx = store[table].indexOf(row);
          if (idx >= 0) Object.assign(store[table][idx], operationData);
        }
        return { _updatedRows: rows };
      }

      if (operation === 'delete') {
        let rows = [...store[table]];
        for (const f of filters) rows = rows.filter(f);
        store[table] = store[table].filter(r => !rows.includes(r));
        return { error: null };
      }

      return { data: null, error: null };
    }

    // The builder object — all methods return `builder` for chaining
    const builder = {
      // Set operation
      select(cols, opts) {
        operation = 'select';
        selectOpts = opts || {};
        return builder;
      },
      insert(row) {
        operation = 'insert';
        operationData = row;
        // For insert, execute immediately and return a chain for .select().single()
        const result = resolve();
        const insertedRow = result._insertedRow;
        return {
          select() {
            return {
              single() {
                return { data: { ...insertedRow }, error: null };
              }
            };
          }
        };
      },
      update(patch) {
        operation = 'update';
        operationData = patch;
        // Return a chain that supports .eq().select().single() after update
        // WHY: In real Supabase, .update(patch).eq('id', x).select().single()
        // means "update matching rows, then return them." The .select() after
        // .update() should NOT reset the operation — it signals "return data."
        const updateBuilder = {
          eq(col, val) { filters.push(row => row[col] === val); return updateBuilder; },
          neq(col, val) { filters.push(row => row[col] !== val); return updateBuilder; },
          select() {
            // Execute the update NOW, then return a select chain for the results
            let rows = [...store[table]];
            for (const f of filters) rows = rows.filter(f);
            for (const row of rows) {
              const idx = store[table].indexOf(row);
              if (idx >= 0) Object.assign(store[table][idx], patch);
            }
            // Get the updated rows
            const updatedRows = rows.map(r => ({ ...r, ...patch }));
            return {
              single() {
                if (updatedRows.length === 0) return { data: null, error: { message: 'No rows found' } };
                return { data: { ...updatedRows[0] }, error: null };
              },
              maybeSingle() {
                return { data: updatedRows.length > 0 ? { ...updatedRows[0] } : null, error: null };
              }
            };
          },
          // Allow destructuring { error } directly from update without .select()
          get error() {
            let rows = [...store[table]];
            for (const f of filters) rows = rows.filter(f);
            for (const row of rows) {
              const idx = store[table].indexOf(row);
              if (idx >= 0) Object.assign(store[table][idx], patch);
            }
            return null;
          }
        };
        return updateBuilder;
      },
      delete() {
        operation = 'delete';
        return builder;
      },
      upsert(rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const row of arr) {
          const existing = store[table].find(r => r.id === row.id);
          if (existing) {
            Object.assign(existing, row);
          } else {
            if (row.id === undefined) row.id = nextId(table);
            if (!row.created_at) row.created_at = new Date().toISOString();
            store[table].push(row);
          }
        }
        return { data: arr, error: null };
      },

      // Filters
      eq(col, val) {
        filters.push(row => row[col] === val);
        return builder;
      },
      neq(col, val) {
        filters.push(row => row[col] !== val);
        return builder;
      },
      gte(col, val) {
        filters.push(row => row[col] >= val);
        return builder;
      },
      lt(col, val) {
        filters.push(row => row[col] < val);
        return builder;
      },
      in(col, vals) {
        filters.push(row => vals.includes(row[col]));
        return builder;
      },
      overlaps(col, vals) {
        filters.push(row => {
          const arr = row[col];
          if (!Array.isArray(arr)) return false;
          return arr.some(v => vals.includes(v));
        });
        return builder;
      },
      or(orString) {
        const conditions = orString.split(',').map(cond => {
          const match = cond.match(/^(\w+)\.eq\.(.+)$/);
          if (match) return row => String(row[match[1]]) === match[2];
          return () => true;
        });
        filters.push(row => conditions.some(fn => fn(row)));
        return builder;
      },

      // Ordering and limiting
      order(col, opts = {}) {
        orderCols.push({ col, ascending: opts.ascending !== false });
        return builder;
      },
      limit(n) {
        limitVal = n;
        return builder;
      },

      // Terminal operations
      single() {
        singleMode = true;
        return resolve();
      },
      maybeSingle() {
        maybeSingleMode = true;
        return resolve();
      },

      // Property access for destructuring — resolves the query
      get data() {
        return resolve().data;
      },
      get error() {
        // For delete/update without .select(), return null (success)
        if (operation === 'delete') return resolve().error;
        if (operation === 'update') return null;
        return resolve().error;
      },
      get count() {
        return resolve().count;
      }
    };

    return builder;
  }

  return {
    from(table) {
      return createQueryBuilder(table);
    },
    __setData(table, rows) {
      store[table] = rows.map(r => ({ ...r }));
    },
    __getData(table) {
      return store[table] ? store[table].map(r => ({ ...r })) : [];
    },
    __reset() {
      for (const key of Object.keys(store)) delete store[key];
      for (const key of Object.keys(idCounters)) delete idCounters[key];
    }
  };
}

module.exports = createMockSupabase;
