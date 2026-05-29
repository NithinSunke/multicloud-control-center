export function validateBody(schema) {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body || {});
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateParams(schema) {
  return (req, _res, next) => {
    try {
      req.params = schema.parse(req.params || {});
      next();
    } catch (error) {
      next(error);
    }
  };
}
