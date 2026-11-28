"""Evaluate bounded Python row transformations over literals supplied in this call."""

import ast
import base64
import csv
import io
import json
import keyword
import math
import operator
import re
import sys

ITEMS = 128
DEPTH = 12
OUTPUT = 8192
VIEWS = (type({}.keys()), type({}.values()), type({}.items()))
ITERABLES = (tuple, list, dict, range, zip, enumerate) + VIEWS
FUNCTIONS = {"len", "sum", "min", "max", "sorted", "enumerate", "zip", "range", "list", "dict", "str", "int", "float", "json.loads", "json.dumps"}
METHODS = {"get", "items", "keys", "values", "upper", "lower", "strip", "split"}
ARITY = {
    "zip": (2, 2), "enumerate": (1, 2), "range": (1, 3), "list": (0, 1), "dict": (0, 1),
    "get": (1, 2), "items": (0, 0), "keys": (0, 0), "values": (0, 0),
    "upper": (0, 0), "lower": (0, 0), "strip": (0, 0), "split": (0, 1),
}


COMPARE = {
    ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le,
    ast.Gt: operator.gt, ast.GtE: operator.ge, ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b,
}


class Unsupported(Exception):
    pass


def require(condition):
    if not condition:
        raise Unsupported()


def local(node):
    require(isinstance(node, ast.Name) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,47}", node.id, re.ASCII))
    require(node.id not in FUNCTIONS | {"print"} and not keyword.iskeyword(node.id))
    return node.id


def loop_names(target):
    if isinstance(target, (ast.List, ast.Tuple)):
        require(1 <= len(target.elts) <= 16)
        return [local(x) for x in target.elts]
    return [local(target)]


def assignment(target, depth):
    if isinstance(target, ast.Subscript):
        local(target.value)
        shape(target.slice, depth + 1)
    else:
        local(target)


def shape(node, depth=0, iterable=False, json_cell=False):
    """Validate every branch, including the bodies of loops with zero rows."""
    require(depth <= DEPTH)
    children = []
    if isinstance(node, ast.Module):
        require(node.body and (isinstance(node.body[0], ast.Assign) or json_cell and isinstance(node.body[0], ast.Expr)))
        require(any(hasattr(stmt, "csv_output") for stmt in node.body) or
                any(named_call(n, "print") for n in ast.walk(node)))
        children = node.body
    elif isinstance(node, ast.With) and hasattr(node, "csv_output"):
        children = [expr for _, expr in node.csv_operations if expr is not None]
        if node.csv_fields is not None:
            children.append(node.csv_fields)
    elif isinstance(node, ast.Assign):
        require(len(node.targets) == 1)
        assignment(node.targets[0], depth)
        children = [node.value]
    elif isinstance(node, ast.AugAssign):
        require(isinstance(node.op, ast.Add))
        assignment(node.target, depth)
        children = [node.value]
    elif isinstance(node, ast.For):
        require(not node.orelse)
        loop_names(node.target)
        shape(node.iter, depth + 1, iterable=True)
        children = node.body
    elif isinstance(node, ast.If):
        children = [node.test, *node.body, *node.orelse]
    elif isinstance(node, ast.IfExp):
        children = [node.test, node.body, node.orelse]
    elif isinstance(node, ast.Compare):
        require(all(type(op) in COMPARE for op in node.ops))
        children = [node.left, *node.comparators]
    elif isinstance(node, ast.ListComp):
        require(len(node.generators) == 1)
        gen = node.generators[0]
        require(not gen.is_async)
        loop_names(gen.target)
        shape(gen.iter, depth + 1, iterable=True)
        children = [*gen.ifs, node.elt]
    elif isinstance(node, ast.Expr):
        call = node.value
        require(isinstance(call, ast.Call) and not call.keywords)
        if isinstance(call.func, ast.Name):
            require(call.func.id == "print" and 1 <= len(call.args) <= 16)
        else:
            require(isinstance(call.func, ast.Attribute) and call.func.attr in {"append", "extend"} and len(call.args) == 1)
            local(call.func.value)
        children = call.args
    elif isinstance(node, ast.Constant):
        scalar(node.value)
    elif isinstance(node, ast.Name):
        local(node)
    elif isinstance(node, (ast.List, ast.Tuple)):
        require(len(node.elts) <= ITEMS)
        children = node.elts
    elif isinstance(node, ast.Dict):
        require(len(node.keys) <= ITEMS and all(isinstance(k, ast.Constant) and type(k.value) is str for k in node.keys))
        children = [*node.keys, *node.values]
    elif isinstance(node, ast.Subscript):
        children = [node.value, node.slice]
    elif isinstance(node, ast.UnaryOp):
        require(isinstance(node.op, (ast.USub, ast.UAdd)))
        children = [node.operand]
    elif isinstance(node, ast.BinOp):
        require(isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)))
        children = [node.left, node.right]
    elif isinstance(node, ast.Call):
        require(not node.keywords and isinstance(node.func, (ast.Name, ast.Attribute)))
        name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr
        minimum, maximum = ARITY.get(name, (1, 1))
        require(minimum <= len(node.args) <= maximum)
        if isinstance(node.func, ast.Name):
            require(node.func.id in FUNCTIONS)
            if node.func.id == "range" and all(isinstance(arg, ast.Constant) for arg in node.args):
                args = [arg.value for arg in node.args]
                require(all(type(v) is int for v in args))
                try:
                    require(len(range(*args)) <= ITEMS)
                except (ValueError, OverflowError):
                    raise Unsupported() from None
            if node.func.id in {"zip", "enumerate", "range"}:
                require(iterable)
            if node.func.id in {"list", "dict", "sorted", "min", "max", "sum", "len", "enumerate", "zip"}:
                for arg in node.args:
                    shape(arg, depth + 1, iterable=True)
            else:
                children = node.args
        else:
            require(isinstance(node.func, ast.Attribute) and node.func.attr in METHODS)
            if node.func.attr in {"items", "keys", "values"}:
                require(iterable)
            children = [node.func.value, *node.args]
    else:
        raise Unsupported()
    for child in children:
        shape(child, depth + 1)


def scalar(value):
    kind = type(value)
    require(kind in (str, int, float, bool, type(None)))
    if kind is str:
        require(len(value.encode("utf-8")) <= 1024)
    if kind is int:
        require(abs(value) < 10**64)
    if kind is float:
        require(math.isfinite(value))
    return value


def bounded(value):
    """Count shared substructures each time they occur. Reject cycles before formatting."""
    remaining = 8192
    def visit(item, depth):
        nonlocal remaining
        require(depth <= DEPTH and remaining > 0)
        remaining -= 1
        if isinstance(item, (dict, tuple, list)):
            require(len(item) <= ITEMS)
            for element in item.items() if isinstance(item, dict) else item:
                visit(element, depth + 1)
        else:
            scalar(item)
            if isinstance(item, str):
                remaining -= len(item.encode("utf-8"))
                require(remaining >= 0)
    visit(value, 0)
    return value


class Rows:
    def __init__(self):
        self.names = {}
        self.steps = 0
        self.output = []
        self.written = 0
        self.csv_file = None

    def tick(self):
        self.steps += 1
        require(self.steps <= 8192)

    def call(self, node):
        args = [self.value(arg) for arg in node.args]
        if isinstance(node.func, ast.Name):
            name = node.func.id
            if name == "json.loads":
                require(type(args[0]) is str)
                return json.loads(args[0])
            if name == "json.dumps":
                return json.dumps(bounded(args[0]), **node.json_options)
            if name == "range":
                require(all(type(v) is int for v in args))
                interval = range(*args)
                require(len(interval) <= ITEMS)
                return interval
            if name == "zip":
                require(all(isinstance(v, ITERABLES) for v in args))
                return zip(*args)
            if name == "enumerate":
                require(isinstance(args[0], ITERABLES))
                return enumerate(*args)
            if name in {"list", "dict"} and not args:
                return [] if name == "list" else {}
            item = args[0]
            if name in {"str", "int", "float"}:
                require(type(item) in (str, int, float, bool))
                return {"str": str, "int": int, "float": float}[name](item)
            require(isinstance(item, ITERABLES + (str,)))
            functions = {"len": len, "sum": sum, "min": min, "max": max, "sorted": sorted, "list": list, "dict": dict}
            return functions[name](item)
        obj = self.value(node.func.value)
        method = node.func.attr
        if method == "get":
            require(type(obj) is dict)
            return obj.get(*args)
        if method in {"items", "keys", "values"}:
            require(type(obj) is dict)
            return {"items": obj.items, "keys": obj.keys, "values": obj.values}[method]()
        require(type(obj) is str)
        if method == "split":
            require(not args or type(args[0]) is str)
            return obj.split(*args)
        return {"upper": obj.upper, "lower": obj.lower, "strip": obj.strip}[method]()

    def bindings(self, target, item):
        names = loop_names(target)
        if isinstance(target, ast.Name):
            self.names[names[0]] = item
        else:
            require(isinstance(item, (list, tuple)) and len(item) == len(names))
            self.names.update(zip(names, item))
        require(len(self.names) <= 64)

    def assign(self, target, value):
        if isinstance(target, ast.Name):
            self.names[target.id] = value
            require(len(self.names) <= 64)
            return
        mapping = self.value(target.value)
        key = self.value(target.slice)
        require(type(mapping) is dict and type(key) in (str, int))
        mapping[key] = value
        bounded(mapping)

    def value(self, node):
        self.tick()
        if isinstance(node, ast.Name):
            if node.id not in self.names:
                raise NameError("name %r is not defined" % node.id)
            return self.names[node.id]
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, (ast.List, ast.Tuple)):
            items = [self.value(n) for n in node.elts]
            return bounded(tuple(items) if isinstance(node, ast.Tuple) else items)
        if isinstance(node, ast.Dict):
            return bounded({k.value: self.value(v) for k, v in zip(node.keys, node.values)})
        if isinstance(node, ast.Subscript):
            obj, key = self.value(node.value), self.value(node.slice)
            require(type(key) in (str, int))
            return obj[key]
        if isinstance(node, ast.IfExp):
            return self.value(node.body if self.value(node.test) else node.orelse)
        if isinstance(node, ast.Compare):
            left = self.value(node.left)
            for op, expr in zip(node.ops, node.comparators):
                right = self.value(expr)
                if not COMPARE[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.ListComp):
            gen = node.generators[0]
            values = self.value(gen.iter)
            require(isinstance(values, ITERABLES))
            previous, self.names = self.names, self.names.copy()
            result = []
            try:
                for item in values:
                    self.tick()
                    self.bindings(gen.target, item)
                    if all(self.value(cond) for cond in gen.ifs):
                        result.append(self.value(node.elt))
            finally:
                self.names = previous
            return bounded(result)
        if isinstance(node, ast.UnaryOp):
            val = self.value(node.operand)
            require(type(val) in (int, float))
            return -val if isinstance(node.op, ast.USub) else val
        if isinstance(node, ast.BinOp):
            left, right = self.value(node.left), self.value(node.right)
            require(type(left) in (int, float) and type(right) in (int, float))
            if isinstance(node.op, ast.Add):
                return scalar(left + right)
            if isinstance(node.op, ast.Sub):
                return scalar(left - right)
            return scalar(left * right)
        result = self.call(node)
        # Iterators and dictionary views are only admitted in iterable positions.
        # Native Python retains current values and iteration order as data changes.
        if isinstance(result, (range, zip, enumerate) + VIEWS):
            return result
        return bounded(result)

    def write_csv(self, stmt):
        with io.StringIO(newline="") as buffer:
            if stmt.csv_fields is None:
                writer = csv.writer(buffer)
            else:
                fields = self.value(stmt.csv_fields)
                require(isinstance(fields, (list, tuple)) and 1 <= len(fields) <= 64
                        and all(type(name) is str for name in fields) and len(set(fields)) == len(fields))
                writer = csv.DictWriter(buffer, fieldnames=fields)
            for operation, expr in stmt.csv_operations:
                self.tick()
                if operation == "writeheader":
                    writer.writeheader()
                else:
                    value = self.value(expr)
                    items = [value] if operation == "writerow" else value
                    require(isinstance(items, (list, tuple)) and len(items) <= ITEMS)
                    for item in items:
                        self.tick()
                        require(isinstance(item, dict if stmt.csv_fields is not None else (list, tuple)) and len(item) <= 64)
                        for cell in item.values() if isinstance(item, dict) else item:
                            scalar(cell)
                        writer.writerow(item)
                        require(buffer.tell() <= OUTPUT)
                require(buffer.tell() <= OUTPUT)
            raw = buffer.getvalue().encode("utf-8")
            require(len(raw) <= OUTPUT)
            self.csv_file = {"path": stmt.csv_output, "base64": base64.b64encode(raw).decode("ascii")}

    def run(self, statements):
        for stmt in statements:
            self.tick()
            if isinstance(stmt, ast.Assign):
                self.assign(stmt.targets[0], self.value(stmt.value))
            elif isinstance(stmt, ast.With) and hasattr(stmt, "csv_output"):
                self.write_csv(stmt)
            elif isinstance(stmt, ast.AugAssign):
                left, right = self.value(stmt.target), self.value(stmt.value)
                require(type(left) in (int, float) and type(right) in (int, float))
                self.assign(stmt.target, scalar(left + right))
            elif isinstance(stmt, ast.If):
                self.run(stmt.body if self.value(stmt.test) else stmt.orelse)
            elif isinstance(stmt, ast.For):
                values = self.value(stmt.iter)
                require(isinstance(values, ITERABLES))
                for item in values:
                    self.tick()
                    self.bindings(stmt.target, item)
                    self.run(stmt.body)
            else:
                call = stmt.value
                if isinstance(call.func, ast.Name):
                    line = " ".join(str(bounded(self.value(arg))) for arg in call.args) + "\n"
                    self.written += len(line.encode("utf-8"))
                    require(self.written <= OUTPUT)
                    self.output.append(line)
                else:
                    items = self.value(call.func.value)
                    value = self.value(call.args[0])
                    require(type(items) is list)
                    if call.func.attr == "append":
                        items.append(value)
                    else:
                        require(type(value) in (list, tuple))
                        items.extend(value)
                    bounded(items)


def named_call(node, name):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == name


def json_options(call):
    options = {}
    for entry in call.keywords:
        key, value = entry.arg, entry.value
        require(key not in options)
        if key in ("ensure_ascii", "sort_keys"):
            require(isinstance(value, ast.Constant) and type(value.value) is bool)
            options[key] = value.value
        elif key == "indent":
            require(isinstance(value, ast.Constant) and (value.value is None or type(value.value) is int and 0 <= value.value <= 4))
            options[key] = value.value
        elif key == "separators":
            require(isinstance(value, ast.Tuple) and len(value.elts) == 2 and all(isinstance(v, ast.Constant) for v in value.elts))
            comma, colon = (v.value for v in value.elts)
            require(comma in (",", ", ") and colon in (":", ": "))
            options[key] = (comma, colon)
        else:
            raise Unsupported()
    return options


def data_imports(tree):
    """Declare structured data formats. No Python import statement is executed."""
    modules = set()
    while tree.body and isinstance(tree.body[0], ast.Import):
        for alias in tree.body.pop(0).names:
            require(alias.name in {"csv", "json"} and alias.asname is None and alias.name not in modules)
            modules.add(alias.name)
    require(tree.body)
    if "csv" in modules:
        # These names designate the verified input and managed output declarations.
        require(not any(isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
                        and node.id in {"csv", "open"} for node in ast.walk(tree)))
    if "json" in modules:
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == "json"):
                continue
            name = node.func.attr
            require(name in {"loads", "dumps"} and len(node.args) == 1 and (name == "dumps" or not node.keywords))
            node.json_options = json_options(node)
            node.keywords = []
            # A dotted name cannot appear as a bare Python identifier in the source.
            node.func = ast.Name(id="json." + name, ctx=ast.Load())
        require(not any(isinstance(node, ast.Name) and node.id == "json" for node in ast.walk(tree)))
    return modules


def csv_output(tree):
    """Describe one managed artifact. No source path or Python file handle is opened."""
    path = None
    for stmt in tree.body:
        if not isinstance(stmt, ast.With) or len(stmt.items) != 1:
            continue
        opening = stmt.items[0].context_expr
        if not (named_call(opening, "open") and len(opening.args) == 2 and isinstance(opening.args[1], ast.Constant)
                and opening.args[1].value == "w"):
            continue
        require(path is None and isinstance(opening.args[0], ast.Constant))
        path = opening.args[0].value
        require(type(path) is str and re.fullmatch(r"output/[A-Za-z0-9][A-Za-z0-9_ .-]{0,78}\.csv", path))
        options = {}
        for option in opening.keywords:
            require(option.arg in {"encoding", "newline"} and option.arg not in options and isinstance(option.value, ast.Constant))
            options[option.arg] = option.value.value
        require(options.get("encoding", "utf-8") == "utf-8" and options.get("newline", "") == "")
        handle = local(stmt.items[0].optional_vars)
        require(len(stmt.body) >= 2)
        setup = stmt.body[0]
        require(isinstance(setup, ast.Assign) and len(setup.targets) == 1)
        binding = local(setup.targets[0])
        factory = setup.value
        require(handle != binding and isinstance(factory, ast.Call) and isinstance(factory.func, ast.Attribute)
                and isinstance(factory.func.value, ast.Name) and factory.func.value.id == "csv")
        require(factory.func.attr in {"writer", "DictWriter"} and factory.args
                and isinstance(factory.args[0], ast.Name) and factory.args[0].id == handle)
        stmt.csv_fields = None
        if factory.func.attr == "writer":
            require(len(factory.args) == 1 and not factory.keywords)
        elif len(factory.args) == 2:
            require(not factory.keywords)
            stmt.csv_fields = factory.args[1]
        else:
            require(len(factory.args) == 1 and len(factory.keywords) == 1 and factory.keywords[0].arg == "fieldnames")
            stmt.csv_fields = factory.keywords[0].value
        stmt.csv_operations = []
        for line in stmt.body[1:]:
            call = line.value if isinstance(line, ast.Expr) else None
            require(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == binding and not call.keywords)
            method = call.func.attr
            require((method == "writeheader" and stmt.csv_fields is not None and not call.args)
                    or (method in {"writerow", "writerows"} and len(call.args) == 1))
            stmt.csv_operations.append((method, call.args[0] if call.args else None))
        # The opaque handles have no other meaning in this evaluator, including in dead branches.
        hidden = {handle, binding}
        for sibling in tree.body:
            if sibling is not stmt:
                require(not any(isinstance(n, ast.Name) and n.id in hidden for n in ast.walk(sibling)))
        operands = [v for _, v in stmt.csv_operations if v is not None]
        if stmt.csv_fields is not None:
            operands.append(stmt.csv_fields)
        require(not any(isinstance(n, ast.Name) and n.id in hidden for expr in operands for n in ast.walk(expr)))
        stmt.csv_output = path
    return path


def csv_input(tree):
    """Recognize one declarative CSV input. The supplied source is never opened."""
    stmt = tree.body[0]
    managed = isinstance(stmt, ast.With)
    if managed:
        require(len(stmt.items) == 1 and len(stmt.body) == 1)
        source = stmt.items[0].context_expr
        handle = local(stmt.items[0].optional_vars)
        stmt = stmt.body[0]
    require(isinstance(stmt, ast.Assign) and len(stmt.targets) == 1)
    target = local(stmt.targets[0])
    outer = stmt.value
    require(named_call(outer, "list") and len(outer.args) == 1 and not outer.keywords)
    reader = outer.args[0]
    require(isinstance(reader, ast.Call) and isinstance(reader.func, ast.Attribute) and reader.func.attr == "DictReader")
    require(isinstance(reader.func.value, ast.Name) and reader.func.value.id == "csv" and len(reader.args) == 1)
    delimiter = ","
    if reader.keywords:
        require(len(reader.keywords) == 1 and reader.keywords[0].arg == "delimiter")
        val = reader.keywords[0].value
        require(isinstance(val, ast.Constant) and val.value in (",", "\t", ";", "|"))
        delimiter = val.value
    if managed:
        require(isinstance(reader.args[0], ast.Name) and reader.args[0].id == handle and handle != target)
    else:
        source = reader.args[0]
    require(named_call(source, "open") and 1 <= len(source.args) <= 2)
    name = source.args[0]
    require(isinstance(name, ast.Constant) and type(name.value) is str and len(name.value) <= 512)
    if len(source.args) == 2:
        require(isinstance(source.args[1], ast.Constant) and source.args[1].value in ("r", "rt"))
    options = {}
    for arg in source.keywords:
        require(arg.arg in {"encoding", "newline"} and arg.arg not in options and isinstance(arg.value, ast.Constant))
        options[arg.arg] = arg.value.value
    encoding = options.get("encoding", "utf-8")
    require(encoding in ("utf-8", "utf-8-sig") and options.get("newline") in ("", None))
    # Replace only the recognized input declaration. Validate every remaining statement normally.
    tree.body[:1] = [ast.Assign(targets=stmt.targets, value=ast.Constant(value=None))]
    return target, name.value, encoding, delimiter, options.get("newline")


def read_csv_rows(data, encoding, delimiter, newline):
    require(type(data) is str and len(data) <= 87384)
    raw = base64.b64decode(data, validate=True)
    require(len(raw) <= 65536)
    stream = io.StringIO(raw.decode(encoding), newline=newline)
    reader = csv.DictReader(stream, delimiter=delimiter)
    require(reader.fieldnames is None or len(reader.fieldnames) <= 64)
    rows = []
    for row in reader:
        require(len(rows) < ITEMS)
        rows.append(row)
    return bounded(rows)


def run_inline_total(rows, statements, claim):
    """Capture operands when a trailing sum or count is evaluated, including named results."""
    last = statements[-1]
    if not (isinstance(last, ast.Expr) and named_call(last.value, "print") and len(last.value.args) == 2):
        rows.run(statements)
        return False
    start = len(statements) - 1
    while start:
        stmt = statements[start - 1]
        if not (isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)
                and (isinstance(stmt.value, ast.Name) or named_call(stmt.value, "sum") or named_call(stmt.value, "len"))):
            break
        start -= 1
    rows.run(statements[:start])
    expected = claim["values"]
    names = {}

    def witness(expr):
        if isinstance(expr, ast.Name):
            return names.get(expr.id)
        if not ((named_call(expr, "sum") or named_call(expr, "len")) and len(expr.args) == 1 and isinstance(expr.args[0], ast.Name)):
            return None
        items = rows.names.get(expr.args[0].id)
        if not isinstance(items, (list, tuple)) or len(items) != len(expected):
            return None
        if all(type(item) is int and item == supplied for item, supplied in zip(items, expected)):
            return expr.func.id
        if named_call(expr, "len") and all(type(row) is dict and type(row.get(claim["field"])) is int
                                          and row[claim["field"]] == val for row, val in zip(items, expected)):
            return "len"
        return None

    for stmt in statements[start:-1]:
        origin = witness(stmt.value)
        rows.run([stmt])
        names[stmt.targets[0].id] = origin
    outputs = [witness(arg) for arg in last.value.args]
    rows.run([last])
    return len(rows.output) == 1 and set(outputs) == {"sum", "len"}


def main(request):
    source = request["code"]
    require(len(source) <= 8192)
    tree = ast.parse(source)
    require(sum(1 for _ in ast.walk(tree)) <= 768)
    formats = data_imports(tree)
    source = csv_input(tree) if "csv" in formats else None
    output_path = csv_output(tree) if source else None
    shape(tree, json_cell="json" in formats)
    if request["action"] == "validate":
        return {"valid": True, **({"source": source[1]} if source else {}), **({"outputPath": output_path} if output_path else {})}
    if output_path:
        require(request.get("outputPath") == output_path)
    rows = Rows()
    try:
        if source:
            name, path, encoding, delimiter, newline = source
            require(request.get("source") == path)
            rows.names[name] = read_csv_rows(request.get("data"), encoding, delimiter, newline)
            rows.run(tree.body[1:])
        elif request.get("inlineTotal"):
            confirmed = run_inline_total(rows, tree.body, request["inlineTotal"])
            return {"output": "".join(rows.output), "confirmedInlineTotal": confirmed}
        else:
            rows.run(tree.body)
        return {"output": "".join(rows.output), **({"csvFile": rows.csv_file} if rows.csv_file else {})}
    except (KeyError, IndexError, NameError, TypeError, ValueError, OverflowError, RuntimeError) as exc:
        kind = "json.decoder.JSONDecodeError" if isinstance(exc, json.JSONDecodeError) else type(exc).__name__
        return {"output": "".join(rows.output), "error": kind + ": " + str(exc)[:512]}


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin)), allow_nan=False))
    except (Unsupported, SyntaxError, UnicodeError, RecursionError):
        print('{"unsupported":true}')
