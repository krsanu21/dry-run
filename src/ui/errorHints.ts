import type { Language } from "../trace/schema";

/**
 * One-line explanations for the errors people hit most while practising.
 * They say what the error usually means and where to look — never how to
 * fix the specific program.
 */
type Rule = [kind: RegExp, message: RegExp, hint: (m: RegExpExecArray) => string];

const PY: Rule[] = [
  [/AttributeError/, /'NoneType' object has no attribute/, () => "The value is None — often a function that doesn't return, or a pointer that walked past the end (node.next is None)."],
  [
    /AttributeError/,
    /'(\w+)' object has no attribute '(\w+)'/,
    (m) => `This value is a ${m[1]}, and ${m[1]} has no .${m[2]}. Step back to where it was last assigned and check what it actually holds.`,
  ],
  [/TypeError/, /'NoneType' object is not (subscriptable|iterable)/, () => "The value is None — often a function that doesn't return, or a lookup that found nothing."],
  [/TypeError/, /unhashable type: '(list|dict|set)'/, (m) => `A ${m[1]} can't be a dict key or set member because it is mutable. A tuple (or frozenset) can.`],
  [/TypeError/, /'(int|float)' object is not iterable/, () => "This loops over a number. To loop n times or over indices, use range(...)."],
  [/TypeError/, /'(int|float|bool)' object is not subscriptable/, (m) => `Indexing into a ${m[1]}. Check whether the variable holds a number where you expected a list or dict.`],
  [/TypeError/, /takes (\d+) positional arguments? but (\d+) (were|was) given/, () => "The call passes a different number of arguments than the definition accepts. Methods also receive self."],
  [/TypeError/, /can only concatenate str|unsupported operand type/, () => "The operands have different types. Convert one explicitly (str(), int()) or check what each one holds."],
  [/TypeError/, /object is not callable/, () => "Something that isn't a function is being called — e.g. a variable that shadows a function name."],
  [/IndexError/, /out of range/, () => "The index is ≥ len(...) or < -len(...). Step back and compare the index variable with the length."],
  [/IndexError/, /pop from empty/, () => "The container is empty here. Check the loop or emptiness condition before popping."],
  [/KeyError/, /.*/, () => "The key isn't in the dict at this point. Use `k in d`, d.get(k, default), or a defaultdict."],
  [/UnboundLocalError/, /.*/, () => "The name is assigned somewhere in this function, so Python treats it as local everywhere in it — but it's read before that assignment runs."],
  [/NameError/, /.*/, () => "The name doesn't exist here: misspelled, never assigned on this path, or defined in a different scope."],
  [/RecursionError/, /.*/, () => "Recursion went too deep — usually a base case that is missing or never reached."],
  [/ZeroDivisionError/, /.*/, () => "A divisor is 0 at this step."],
  [/ValueError/, /too many values to unpack|not enough values to unpack/, () => "The number of names on the left doesn't match the number of items on the right."],
  [/IndentationError|TabError/, /.*/, () => "Every line in a block needs the same indentation as its siblings, one level deeper than the line ending in ':'. Don't mix tabs and spaces."],
  [/SyntaxError/, /invalid syntax/, () => "Python reports where it got confused; the real mistake is often just before — an unclosed bracket or quote on an earlier line."],
];

const JS: Rule[] = [
  [/TypeError/, /Cannot read propert(y|ies) of (undefined|null)/, (m) => `The value is ${m[2]} — an index past the end, a missing key, or a pointer that walked past the last node.`],
  [/TypeError/, /Cannot set propert(y|ies) of (undefined|null)/, (m) => `Assigning a property on ${m[2]}. Check that the object exists at this step.`],
  [/TypeError/, /is not a function/, () => "This value isn't a function at this step. Check the name and what the variable holds."],
  [/TypeError/, /Assignment to constant variable/, () => "A const binding can't be reassigned. Use let for variables that change."],
  [/TypeError/, /is not iterable/, () => "for...of needs an array, string, Map or Set. To loop over object keys use Object.keys(...)."],
  [/ReferenceError/, /before initialization/, () => "let/const variables can't be read before their declaration line runs."],
  [/ReferenceError/, /is not defined/, () => "The name doesn't exist here: misspelled, never declared, or declared in a different scope."],
  [/RangeError/, /Maximum call stack/, () => "Recursion went too deep — usually a base case that is missing or never reached."],
  [/SyntaxError/, /Unexpected token|Unexpected character/, () => "The parser got confused here; the real mistake is often just before — an unclosed bracket, brace or quote."],
];

export function errorHint(kind: string, message: string, language: Language): string | null {
  for (const [k, re, hint] of language === "python" ? PY : JS) {
    if (!k.test(kind)) continue;
    const m = re.exec(message);
    if (m) return hint(m);
  }
  return null;
}
