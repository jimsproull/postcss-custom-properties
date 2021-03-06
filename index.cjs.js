'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

function _interopNamespace(e) {
	if (e && e.__esModule) { return e; } else {
		var n = {};
		if (e) {
			Object.keys(e).forEach(function (k) {
				var d = Object.getOwnPropertyDescriptor(e, k);
				Object.defineProperty(n, k, d.get ? d : {
					enumerable: true,
					get: function () {
						return e[k];
					}
				});
			});
		}
		n['default'] = e;
		return n;
	}
}

var postcss = _interopDefault(require('postcss'));
var postcssValuesParser = require('postcss-values-parser');
var fs = _interopDefault(require('fs'));
var path = _interopDefault(require('path'));

function isBlockIgnored(ruleOrDeclaration) {
  var rule = ruleOrDeclaration.selector ? ruleOrDeclaration : ruleOrDeclaration.parent;
  return /(!\s*)?postcss-custom-properties:\s*off\b/i.test(rule.toString());
}

function isRuleIgnored(rule) {
  var previous = rule.prev();
  return Boolean(isBlockIgnored(rule) || previous && previous.type === 'comment' && /(!\s*)?postcss-custom-properties:\s*ignore\s+next\b/i.test(previous.text));
}

function getCustomPropertiesFromRoot(root, opts) {
  // initialize custom selectors
  let customProperties = {};
  const nodes = root.nodes;
  nodes.slice().forEach(rule => {
    if (rule.type == "root") {
      customProperties = Object.assign({}, customProperties, getCustomPropertiesFromRoot(rule, opts));
    } else {
      customProperties = Object.assign({}, customProperties, extractProperties(rule, opts.preserve));
    }
  }); // return all custom properties, preferring :root properties over html properties

  return Object.assign({}, customProperties);
} // match html and :root rules

const htmlSelectorRegExp = /^html$/i;
const rootSelectorRegExp = /^:root$/i;
const customPropertyRegExp = /^--[A-z][\w-]*$/; // whether the node is an html or :root rule

const isHtmlRule = node => node.type === "rule" && node.selector.split(",").some(item => htmlSelectorRegExp.test(item)) && Object(node.nodes).length;

const isRootRule = node => node.type === "rule" && node.selector.split(",").some(item => rootSelectorRegExp.test(item)) && Object(node.nodes).length; // whether the node is an custom property


const isCustomDecl = node => node.type === "decl" && customPropertyRegExp.test(node.prop); // whether the node is a parent without children


const isEmptyParent = node => Object(node.nodes).length === 0;

function extractProperties(rule, preserve) {
  const customPropertiesObject = {};

  if (isHtmlRule(rule) || isRootRule(rule)) {
    rule.nodes.slice().forEach(decl => {
      if (isCustomDecl(decl) && !isBlockIgnored(decl)) {
        const {
          prop
        } = decl; // write the parsed value to the custom property

        customPropertiesObject[prop] = postcssValuesParser.parse(decl.value).nodes; // conditionally remove the custom property declaration

        if (!preserve) {
          decl.remove();
        }
      }
    }); // conditionally remove the empty html or :root rule

    if (!preserve && isEmptyParent(rule) && !isBlockIgnored(rule)) {
      rule.remove();
    }
  }

  return customPropertiesObject;
}

/* Get Custom Properties from CSS File
/* ========================================================================== */

async function getCustomPropertiesFromCSSFile(from) {
  const css = await readFile(from);
  const root = postcss.parse(css, {
    from
  });
  return getCustomPropertiesFromRoot(root, {
    preserve: true
  });
}
/* Get Custom Properties from Object
/* ========================================================================== */


function getCustomPropertiesFromObject(object) {
  const customProperties = Object.assign({}, Object(object).customProperties, Object(object)["custom-properties"]);

  for (const key in customProperties) {
    customProperties[key] = postcssValuesParser.parse(String(customProperties[key])).nodes;
  }

  return customProperties;
}
/* Get Custom Properties from JSON file
/* ========================================================================== */


async function getCustomPropertiesFromJSONFile(from) {
  const object = await readJSON(from);
  return getCustomPropertiesFromObject(object);
}
/* Get Custom Properties from JS file
/* ========================================================================== */


async function getCustomPropertiesFromJSFile(from) {
  const object = await new Promise(function (resolve) { resolve(_interopNamespace(require(from))); });
  return getCustomPropertiesFromObject(object);
}
/* Get Custom Properties from Imports
/* ========================================================================== */


function getCustomPropertiesFromImports(sources) {
  return sources.map(source => {
    if (source instanceof Promise) {
      return source;
    } else if (source instanceof Function) {
      return source();
    } // read the source as an object


    const opts = source === Object(source) ? source : {
      from: String(source)
    }; // skip objects with Custom Properties

    if (opts.customProperties || opts["custom-properties"]) {
      return opts;
    } // source pathname


    const from = path.resolve(String(opts.from || "")); // type of file being read from

    const type = (opts.type || path.extname(from).slice(1)).toLowerCase();
    return {
      type,
      from
    };
  }).reduce(async (customProperties, source) => {
    const {
      type,
      from
    } = await source;

    if (type === "css" || type === "pcss") {
      return Object.assign(await customProperties, await getCustomPropertiesFromCSSFile(from));
    }

    if (type === "js") {
      return Object.assign(await customProperties, await getCustomPropertiesFromJSFile(from));
    }

    if (type === "json") {
      return Object.assign(await customProperties, await getCustomPropertiesFromJSONFile(from));
    }

    return Object.assign(await customProperties, await getCustomPropertiesFromObject(await source));
  }, {});
}
/* Helper utilities
/* ========================================================================== */

const readFile = from => new Promise((resolve, reject) => {
  fs.readFile(from, "utf8", (error, result) => {
    if (error) {
      reject(error);
    } else {
      resolve(result);
    }
  });
});

const readJSON = async from => JSON.parse(await readFile(from));

function transformValueAST(root, customProperties) {
  if (root.nodes && root.nodes.length) {
    root.nodes.slice().forEach(child => {
      if (isVarFunction(child)) {
        // eslint-disable-next-line no-unused-vars
        const [propertyNode, comma, ...fallbacks] = child.nodes;
        const {
          value: name
        } = propertyNode;

        if (name in Object(customProperties)) {
          // conditionally replace a known custom property
          const nodes = asClonedArrayWithBeforeSpacing(customProperties[name], child.raws.before);
          /**
           * https://github.com/postcss/postcss-custom-properties/issues/221
           * https://github.com/postcss/postcss-custom-properties/issues/218
           *
           * replaceWith loses node.raws values, so we need to save it and restore
           */

          const raws = nodes.map(node => Object.assign({}, node.raws));
          child.replaceWith(...nodes);
          nodes.forEach((node, index) => {
            node.raws = raws[index];
          });
          retransformValueAST({
            nodes
          }, customProperties, name);
        } else if (fallbacks.length) {
          // conditionally replace a custom property with a fallback
          const index = root.nodes.indexOf(child);

          if (index !== -1) {
            root.nodes.splice(index, 1, ...asClonedArrayWithBeforeSpacing(fallbacks, child.raws.before));
          }

          transformValueAST(root, customProperties);
        }
      } else {
        transformValueAST(child, customProperties);
      }
    });
  }

  return root;
} // retransform the current ast without a custom property (to prevent recursion)

function retransformValueAST(root, customProperties, withoutProperty) {
  const nextCustomProperties = Object.assign({}, customProperties);
  delete nextCustomProperties[withoutProperty];
  return transformValueAST(root, nextCustomProperties);
} // match var() functions


const varRegExp = /^var$/i; // whether the node is a var() function

const isVarFunction = node => node.type === 'func' && varRegExp.test(node.name) && Object(node.nodes).length > 0; // return an array with its nodes cloned, preserving the raw


const asClonedArrayWithBeforeSpacing = (array, beforeSpacing) => {
  const clonedArray = asClonedArray(array, null);

  if (clonedArray[0]) {
    clonedArray[0].raws.before = beforeSpacing;
  }

  return clonedArray;
}; // return an array with its nodes cloned


const asClonedArray = (array, parent) => array.map(node => asClonedNode(node, parent)); // return a cloned node


const asClonedNode = (node, parent) => {
  const cloneNode = new node.constructor(node);

  for (const key in node) {
    if (key === 'parent') {
      cloneNode.parent = parent;
    } else if (Object(node[key]).constructor === Array) {
      cloneNode[key] = asClonedArray(node.nodes, cloneNode);
    } else if (Object(node[key]).constructor === Object) {
      cloneNode[key] = Object.assign({}, node[key]);
    }
  }

  return cloneNode;
};

var transformProperties = ((root, customProperties, opts) => {
  // walk decls that can be transformed
  root.walkDecls(decl => {
    if (isTransformableDecl(decl) && !isRuleIgnored(decl)) {
      const originalValue = decl.value;
      const valueAST = postcssValuesParser.parse(originalValue);
      const value = String(transformValueAST(valueAST, customProperties)); // conditionally transform values that have changed

      if (value !== originalValue) {
        if (opts.preserve) {
          const beforeDecl = decl.cloneBefore({
            value
          });

          if (hasTrailingComment(beforeDecl)) {
            beforeDecl.raws.value.value = beforeDecl.value.replace(trailingCommentRegExp, "$1");
            beforeDecl.raws.value.raw = beforeDecl.raws.value.value + beforeDecl.raws.value.raw.replace(trailingCommentRegExp, "$2");
          }
        } else {
          decl.value = value;

          if (hasTrailingComment(decl)) {
            decl.raws.value.value = decl.value.replace(trailingCommentRegExp, "$1");
            decl.raws.value.raw = decl.raws.value.value + decl.raws.value.raw.replace(trailingCommentRegExp, "$2");
          }
        }
      }
    }
  });
}); // match custom properties

const customPropertyRegExp$1 = /^--[A-z][\w-]*$/; // match custom property inclusions

const customPropertiesRegExp = /(^|[^\w-])var\([\W\w]+\)/; // whether the declaration should be potentially transformed

const isTransformableDecl = decl => !customPropertyRegExp$1.test(decl.prop) && customPropertiesRegExp.test(decl.value); // whether the declaration has a trailing comment


const hasTrailingComment = decl => "value" in Object(Object(decl.raws).value) && "raw" in decl.raws.value && trailingCommentRegExp.test(decl.raws.value.raw);

const trailingCommentRegExp = /^([\W\w]+)(\s*\/\*[\W\w]+?\*\/)$/;

/* Write Custom Properties to CSS File
/* ========================================================================== */

async function writeCustomPropertiesToCssFile(to, customProperties) {
  const cssContent = Object.keys(customProperties).reduce((cssLines, name) => {
    cssLines.push(`\t${name}: ${customProperties[name]};`);
    return cssLines;
  }, []).join('\n');
  const css = `:root {\n${cssContent}\n}\n`;
  await writeFile(to, css);
}
/* Write Custom Properties to SCSS File
/* ========================================================================== */


async function writeCustomPropertiesToScssFile(to, customProperties) {
  const scssContent = Object.keys(customProperties).reduce((scssLines, name) => {
    const scssName = name.replace('--', '$');
    scssLines.push(`${scssName}: ${customProperties[name]};`);
    return scssLines;
  }, []).join('\n');
  const scss = `${scssContent}\n`;
  await writeFile(to, scss);
}
/* Write Custom Properties to JSON file
/* ========================================================================== */


async function writeCustomPropertiesToJsonFile(to, customProperties) {
  const jsonContent = JSON.stringify({
    'custom-properties': customProperties
  }, null, '  ');
  const json = `${jsonContent}\n`;
  await writeFile(to, json);
}
/* Write Custom Properties to Common JS file
/* ========================================================================== */


async function writeCustomPropertiesToCjsFile(to, customProperties) {
  const jsContents = Object.keys(customProperties).reduce((jsLines, name) => {
    jsLines.push(`\t\t'${escapeForJS(name)}': '${escapeForJS(customProperties[name])}'`);
    return jsLines;
  }, []).join(',\n');
  const js = `module.exports = {\n\tcustomProperties: {\n${jsContents}\n\t}\n};\n`;
  await writeFile(to, js);
}
/* Write Custom Properties to Module JS file
/* ========================================================================== */


async function writeCustomPropertiesToMjsFile(to, customProperties) {
  const mjsContents = Object.keys(customProperties).reduce((mjsLines, name) => {
    mjsLines.push(`\t'${escapeForJS(name)}': '${escapeForJS(customProperties[name])}'`);
    return mjsLines;
  }, []).join(',\n');
  const mjs = `export const customProperties = {\n${mjsContents}\n};\n`;
  await writeFile(to, mjs);
}
/* Write Custom Properties to Exports
/* ========================================================================== */


function writeCustomPropertiesToExports(customProperties, destinations) {
  return Promise.all(destinations.map(async destination => {
    if (destination instanceof Function) {
      await destination(defaultCustomPropertiesToJSON(customProperties));
    } else {
      // read the destination as an object
      const opts = destination === Object(destination) ? destination : {
        to: String(destination)
      }; // transformer for Custom Properties into a JSON-compatible object

      const toJSON = opts.toJSON || defaultCustomPropertiesToJSON;

      if ('customProperties' in opts) {
        // write directly to an object as customProperties
        opts.customProperties = toJSON(customProperties);
      } else if ('custom-properties' in opts) {
        // write directly to an object as custom-properties
        opts['custom-properties'] = toJSON(customProperties);
      } else {
        // destination pathname
        const to = String(opts.to || ''); // type of file being written to

        const type = (opts.type || path.extname(opts.to).slice(1)).toLowerCase(); // transformed Custom Properties

        const customPropertiesJSON = toJSON(customProperties);

        if (type === 'css') {
          await writeCustomPropertiesToCssFile(to, customPropertiesJSON);
        }

        if (type === 'scss') {
          await writeCustomPropertiesToScssFile(to, customPropertiesJSON);
        }

        if (type === 'js') {
          await writeCustomPropertiesToCjsFile(to, customPropertiesJSON);
        }

        if (type === 'json') {
          await writeCustomPropertiesToJsonFile(to, customPropertiesJSON);
        }

        if (type === 'mjs') {
          await writeCustomPropertiesToMjsFile(to, customPropertiesJSON);
        }
      }
    }
  }));
}
/* Helper utilities
/* ========================================================================== */

const defaultCustomPropertiesToJSON = customProperties => {
  return Object.keys(customProperties).reduce((customPropertiesJSON, key) => {
    const valueNodes = customProperties[key];
    customPropertiesJSON[key] = valueNodes.map(propertyObject => {
      return propertyObject.toString();
    }).join(' ');
    return customPropertiesJSON;
  }, {});
};

const writeFile = (to, text) => new Promise((resolve, reject) => {
  fs.writeFile(to, text, error => {
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  });
});

const escapeForJS = string => string.replace(/\\([\s\S])|(')/g, '\\$1$2').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

var index = postcss.plugin("postcss-custom-properties", opts => {
  // whether to preserve custom selectors and rules using them
  const preserve = "preserve" in Object(opts) ? Boolean(opts.preserve) : true; // sources to import custom selectors from

  const importFrom = [].concat(Object(opts).importFrom || []); // destinations to export custom selectors to

  const exportTo = [].concat(Object(opts).exportTo || []); // promise any custom selectors are imported

  const customPropertiesPromise = getCustomPropertiesFromImports(importFrom); // synchronous transform

  const syncTransform = root => {
    const customProperties = getCustomPropertiesFromRoot(root, {
      preserve
    });
    transformProperties(root, customProperties, {
      preserve
    });
  }; // asynchronous transform


  const asyncTransform = async root => {
    const customProperties = Object.assign({}, getCustomPropertiesFromRoot(root, {
      preserve
    }), await customPropertiesPromise);
    await writeCustomPropertiesToExports(customProperties, exportTo);
    transformProperties(root, customProperties, {
      preserve
    });
  }; // whether to return synchronous function if no asynchronous operations are requested


  const canReturnSyncFunction = importFrom.length === 0 && exportTo.length === 0;
  return canReturnSyncFunction ? syncTransform : asyncTransform;
});

module.exports = index;
//# sourceMappingURL=index.cjs.js.map
