const marked = require('marked');
const sanitizeHtml = require('sanitize-html');
const toml = require('toml');
const fs = require('fs');
const path = require('path');
const prettier = require('@prettier/sync');
const kase = require('case');
const handlebars = require('handlebars');
const { execSync } = require('child_process');

const NAMES_ORDER = '#abcdefghijklmnopqrstuvwxyz';

const PAGES = {};
const NOW = new Date(Date.now());

const VARS = { 
    ...toml.parse(fs.readFileSync('./data/vars.toml', 'utf-8')),
    gendate: NOW.toUTCString(), // NOW.getDate() + '/' + NOW.toLocaleString('default', { month: 'long' }) + '/' + NOW.getFullYear()
};


kase.ident = function(str) { return kase.kebab(kase.lower(str)); }
kase.article = function(str) {
    str = kase.title(str.trim());
    if (str.startsWith('The ')) {
        str = str.substring(3).trim() + ', The';
    }
    if (str.startsWith('A ')) {
        str = str.substring(1).trim() + ', A';
    }
    return str;
}

const descriptionList = {
    name: 'descriptionList',
    level: 'block',                                     // Is this a block-level or inline-level tokenizer?
    start(src) { return src.match(/:[^:\n]/)?.index; }, // Hint to Marked.js to stop and check for a match
    tokenizer(src, tokens) {
      const rule = /^(?::[^:\n]+:[^:\n]*(?:\n|$))+/;    // Regex for the complete token, anchor to string start
      const match = rule.exec(src);
      if (match) {
        const token = {                                 // Token to generate
          type: 'descriptionList',                      // Should match "name" above
          raw: match[0],                                // Text to consume from the source
          text: match[0].trim(),                        // Additional custom properties
          tokens: []                                    // Array where child inline tokens will be generated
        };
        this.lexer.inline(token.text, token.tokens);    // Queue this data to be processed for inline tokens
        return token;
      }
    },
    renderer(token) {
      return `<dl>${this.parser.parseInline(token.tokens)}\n</dl>`; // parseInline to turn child tokens into HTML
    }
};
  
  const description = {
    name: 'description',
    level: 'inline',                                 // Is this a block-level or inline-level tokenizer?
    start(src) { return src.match(/:/)?.index; },    // Hint to Marked.js to stop and check for a match
    tokenizer(src, tokens) {
      const rule = /^:([^:\n]+):([^:\n]*)(?:\n|$)/;  // Regex for the complete token, anchor to string start
      const match = rule.exec(src);
      if (match) {
        return {                                         // Token to generate
          type: 'description',                           // Should match "name" above
          raw: match[0],                                 // Text to consume from the source
          dt: this.lexer.inlineTokens(match[1].trim()),  // Additional custom properties, including
          dd: this.lexer.inlineTokens(match[2].trim())   //   any further-nested inline tokens
        };
      }
    },
    renderer(token) {
      return `\n<dt>${this.parser.parseInline(token.dt)}</dt><dd>${this.parser.parseInline(token.dd)}</dd>`;
    },
    childTokens: ['dt', 'dd'],                 // Any child tokens to be visited by walkTokens
};

marked.use({ extensions: [descriptionList, description] });




const HTML2_OPTIONS = {
    allowedTags: [ 
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7',
        'p', 'address', 'blockquote',
        'ul', 'li', 'ol', 'dir', 'menu', 'dl', 'dt', 'dd',
        'cite', 'code', 'em', 'kbd', 'samp', 'strong', 'var',
        'b', 'i', 't',
        'br', 'hr',
        'img',
        'a'
    ],
    allowedAttributes: {
        'a': [ 'href' ]
    },
    transformTags: {
        'strong': 'b',
        'em' : 'i'
    },
    parser: {
        lowerCaseTags: false,
        lowerCaseAttributeNames: false
    },
    allowedIframeHostnames: []
};

const HTML_NO_CLOSERS = [
    'li', 'dt', 'dd'
]
const HTML_ATTRS = [
    'a href'
]
const AUTHORS = {
    'unknown' : 'Unknown',
    ... toml.parse(fs.readFileSync('./data/authors.toml', 'utf-8'))
};
const SYSTEMS = {
    'unknown' : 'Unknown',
    ... toml.parse(fs.readFileSync('./data/systems.toml', 'utf-8'))
}
const HTML_REPLACEMENTS = [
    [ "'" , '&apos;' ],
    [ '&#x27;' , '&apos;' ]
];

function parseBoolOrFalse(value, meta) {
    if (value == undefined)
        return false;
    return value;
}

function parseBoolOrTrue(value, meta) {
    if (value == undefined)
        return false;
    return value;
}

const MUSTACHE_FNS = {
    list: (arr, suffix = '') => {
        if (arr == null || arr.length == 0)
            return '';
    const useOxfordComma = true;
    const listStart = arr.slice(0, -1).join(', ')
    const listEnd = arr.slice(-1)
    const conjunction = arr.length <= 1 
        ? '' 
        : useOxfordComma && arr.length > 2 
        ? ', and ' 
        : ' and '

    return [listStart, listEnd].join(conjunction) + suffix;
    },
    years: (x) => {
        return x.join('-');
    },
    meta: (x) => {
        let html = '';
        if (x != undefined) {
            for(const name of Object.keys(x)) {
                const value = x[name];
                html += `\n\t<META NAME="${name}" CONTENT="${value}">`
            }
        }
        return html;
    }
}

const PARTIALS = {
    'chrome' : handlebars.compile(fs.readFileSync('./data/partials/chrome.html', 'utf-8')),
    'gameinfo' : fs.readFileSync('./data/partials/gameinfo.md', 'utf-8'),
    'finalscore' : fs.readFileSync('./data/partials/finalscore.md', 'utf-8')
}

const PAGE_FILTERS = {
    article: function(value, meta) {
        let article = kase.article(meta.name || 'unknown');
        if (meta.todo != undefined && meta.todo) {
            article += ' (TODO)';
        }
        return article;
    },
    game: function(value, meta) {
        if (value == undefined) {
            return meta.src_path.indexOf('/games') != -1;
        }
        return value;
    },
    score: function(value, meta) {
        return value || undefined;
    },
    link: function(value, meta) {
        return `[${meta.article}](/${meta.id}.HTML)`;
    },
    author: function(value, meta) {
        return kase.ident(value || 'Unknown');
    },
    author_article: function(value, meta) {
        return AUTHORS[meta.author] || 'Unknown';
    },
    author_link: function(value, meta) {
        return `[${meta.author_article}](/AUTHORS.HTML#${meta.author})`;
    },
    systems: function(value, meta) {
        if (value == undefined) {
            return [];
        }
        return [ ...value].sort();
    },
    systems_links: function(value, meta) {
        let p = [];
        for(const pname of (meta.systems || [])) {
            p.push(`[${SYSTEMS[pname] || 'Unknown'}](/SYSTEMS.HTML#${pname})`);
        }
        return p;
    },
    title: function(value, meta) {
        if (meta.title != undefined) {
            return meta.title;
        }

        if (meta.game) {
            return `Toilet Adventures - ${meta.name}`;
        }
        else {
            return 'Toilet Adventures';
        }
    },
    dst_path : function(value, meta) {
        return `./build/${meta.id}.HTML`;
    },
    sort_names: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        if (meta.game == false) {
            return undefined;
        }
        let ch = meta.article.trim().toLowerCase()[0];
        if (isNaN(parseInt(ch)) == false) {
            return '#';
        }
        return ch;
    },
    sort_years: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        const date = meta.date;
        if (date == undefined) {
            return undefined;
        }
        if (Array.isArray(date)) {
            if (date.length == 1) {
                return date[0]
            }
            else {
                return date[0] + Math.floor((date[1] - date[0]) / 2);
            }
        }
        return date;
    },
    sort_scores: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        return meta.score;
    },
    sort_authors: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        return meta.author == 'unknown' ? undefined : meta.author;
    },
    sort_systems: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        return meta.systems || [];
    },
    todo: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        return false;
    },
    hide: function(value, meta) {
        if (value != undefined) {
            return value;
        }
        return false;
    },
    headers: function(value, meta) {
        let headers = {};
        if (meta.id == 'INDEX') {
            headers['robots'] = 'index, follow';
        }
        headers['Content-Language'] = 'en-GB';
        headers['author'] = 'Writers at toilet-adventures.com';
        return headers;
    }
 };

function load_page(src_path) {
    const id = path.basename(src_path, path.extname(src_path)).toUpperCase();
    if (id.length > 8) {
        throw `${src_path} is too long (${id.length}) to use as an id`;
    }

    const page_data = fs.readFileSync(src_path, 'utf-8');
    const sections = page_data.split('---', 2);
    const meta = toml.parse(sections[0].trim());
    const md = sections[1].trim();
   
    meta.id =  id;
    meta.key = id.toLowerCase();
    meta.src_path = src_path;

    let page = {
        md: md
    };

    for(const filter of Object.keys(PAGE_FILTERS)) {
        meta[filter] = PAGE_FILTERS[filter](meta[filter], meta);
    }

    for(const key of Object.keys(meta)) {
        page[key] = meta[key];
    }

    if (page.hide) {
        console.warn(`${page.id} is marked as hidden`);
        return null;
    }

    return page;
}

function sortPages(p) {
    return Object.keys(p)
        .sort()
        .reduce((accumulator, key) => {
            accumulator[key] = p[key];

            return accumulator;
        }, {});
}

function buildPage(name, pages) {
    const meta = {
        id: kase.kebab(name).toUpperCase(),
        key: kase.kebab(name).toLowerCase(),
        name: kase.title(name),
        src_path: `./data/pages/${this.key}.md`,
        title: `Toilet Adventures - ${kase.title(name)}`,
        game: false
    };

    let page = {};

    for(const filter of Object.keys(PAGE_FILTERS)) {
        meta[filter] = PAGE_FILTERS[filter](meta[filter], meta);
    }

    for(const key of Object.keys(meta)) {
        page[key] = meta[key];
    }

    let md = `# ${meta.article}\n\n`;
    let sections = [];
    let needle_key_name = null;
    let needles = null;
    let titles = {};
    let needle_index_of = false;
    let flat = false;
    let all = false;

    if (name == 'names') {
        needles = NAMES_ORDER.split('');
        needle_key_name = 'sort_names';
        for(const needle of needles) {
            titles[needle] = kase.title(needle);
        }
    }
    else if (name == 'years') {
        needles = [];
        for(let i=1970;i <= 2030;i++) {
            needles.push(i);
            titles[i] = i.toString();
        }
        needle_key_name = 'sort_years';
    }

    else if (name == 'scores') {
        needles = [0.5,1,2,3,4,5,6,7,8,9,10]
        titles['0.5'] = '0.5';
        titles['1'] = '1';
        titles['2'] = '2';
        titles['3'] = '3';
        titles['4'] = '4';
        titles['5'] = '5';
        titles['6'] = '6';
        titles['7'] = '7';
        titles['8'] = '8';
        needle_key_name = 'sort_scores';
    }
    else if (name == 'authors') {
        needles = Object.keys(AUTHORS);
        needle_key_name = 'sort_authors';
        for(const needle of needles) {
            titles[needle] = AUTHORS[needle];
        }
    }
    else if (name == 'systems') {
        needles = Object.keys(SYSTEMS);
        needle_key_name = 'sort_systems';
        needle_index_of = true;
        for(const needle of needles) {
            titles[needle] = SYSTEMS[needle];
        }
    }
    else if (name == 'sitemap') {
        flat = true;
        all = true;
        needles = [true];
        needle_key_name = '';
    }

    if (needles != null && needle_key_name != null) {
        for(const needle_value of needles) {
            let section = null;
            for(const page_name of Object.keys(pages)) {
                const needle_page = pages[page_name];
                if (!all && needle_page.game == false) {
                    continue;
                }

                let match = false;

                if (all == true) {
                    match = true;
                }
                else if (needle_index_of == false) {
                    match = (needle_page[needle_key_name] == needle_value);
                }
                else {
                    match = (needle_page[needle_key_name].indexOf(needle_value) != -1);
                }

                if (match) {
                    if (section == null) {
                        section = {};
                    }
                    section[needle_page.key] = needle_page;
                }
            }

            if (section != null) {
                sections.push([needle_value, section]);
            }
        }
    }
    
    for(const skk of sections) {
        const section_key = skk[0];
        const section = sortPages(skk[1]);

        if (!flat) {
            let anchor = section_key.toString().replaceAll('.', '_');
            md += `## ${titles[section_key]} ~${kase.upper(name)}:${anchor}\n`;
        }

        for(const section_page_name in section) {
            const section_page = section[section_page_name];
            md += `* ${section_page.link}\n`;
        }
        md += '\n';
    }

    page.md = md;
    pages[page.key] = page;
    return page;
}

function writeHtml(page) {

    let md = page.md;

    if (page.todo == true) {
        md = '\n** Cannot publish!!! Work in Progress **\n' + md;
    }

    md = md.replaceAll(/@(\w+)\b/g, function(match, p) {
        const tgt = PAGES[p];
        if (tgt == null) {
            throw `Could not find page for @${p} in ${page.id}`;
        }
        return tgt.link;
    });

    md = md.replaceAll(/!!!(\w+)!!!/g, function(match, p) {
        const partial = PARTIALS[p];
        if (partial == null) {
            throw `Could not partial called ${p} in ${page.id}`;
        }
        return partial;
    });

    const args = {...page, ...MUSTACHE_FNS };
    md = handlebars.compile(md)(args);

    let html = marked.parse(md);
    html = sanitizeHtml(html, HTML2_OPTIONS);
    html = prettier.format(html, {
        parser: 'html', 
        useTabs: true,
        bracketSameLine: true, 
        endOfLine: 'lf', 
        singleAttributePerLine: false});
    
    html = html.replaceAll(/~(\w+):(\w+)\b/g, function(match, p1, p2) {
        return `<A NAME="/${p1}.HTML#${p2}"></A>`;
    });
    
    // <a href=" to <A HREF="
    for(const attr of HTML_ATTRS) {
        html = html.replaceAll(`<${attr}="`, `<${attr.toUpperCase()}="`);
    }

    // Remove </li>
    for(const closer of HTML_NO_CLOSERS) {
        html = html.replaceAll(`</${closer}>`, '');
    }
    
    // <li> to <LI>
    html = html.replaceAll(/<(\w+)/g, function(m, tag) {
        return `<${tag.toUpperCase()}`;
    });

    // </li> to </LI>
    html = html.replaceAll(/<\/(\w+)>/g, function(m, tag) {
        return `</${tag.toUpperCase()}>`;
    });

    // Bump header levels
    html = html.replaceAll(/<H(\d)>/g, function(m, p) {
        return `<H${parseInt(p)+1}>`;
    });
    html = html.replaceAll(/<\/H(\d)>/g, function(m, p) {
        return `</H${parseInt(p)+1}>`;
    });

    // Indent
    html = '\t' + html.replaceAll('\n', '\n\t').trim();

    page.html = html;

    let chrome = PARTIALS.chrome({...page, ...VARS, ...MUSTACHE_FNS});

    for(const r of HTML_REPLACEMENTS) {
        chrome = chrome.replaceAll(r[0], r[1]);
    }

    let lines = chrome.split('\n');
    chrome = '';
    for(let line of lines) {
        if (line.trim().length == 0)
            continue;
        chrome += line + '\n';
    }


    
    return chrome;
}

function readPageDir(dir_path, pages) {
    for(const fn of fs.readdirSync(dir_path)) {
        if (fn.endsWith('.md') == false)
            continue;
        const src_path = path.join(dir_path, fn);
        const page = load_page(src_path);
        if (page == null) { // || page.todo == true) {
            continue;
        }
        page.src_path = src_path;
        pages[page.key] = page;
    }
}

function writePagesHtml(pages) {
    for(const page_key of Object.keys(pages)) {
        const page = pages[page_key];
        const html = writeHtml(page);
        fs.writeFileSync(page.dst_path, html, { encoding: 'ascii'});
    }
}

function writeRedirects(pages) {
    let text = '/ /INDEX.HTML 302\n';
    for(const page_name of Object.keys(PAGES)) {
        const page = PAGES[page_name];
        if (page.todo)
            continue;
        text += `/${page.id.toLowerCase()}.html /${page.id.toUpperCase()}.HTML 301\n`;
    }
    text += '/* /SITEMAP.HTML 404\n';
    fs.writeFileSync('./build/_redirects', text);
}

readPageDir('./data/pages/', PAGES);
readPageDir('./data/games/', PAGES);
buildPage('names', PAGES);
buildPage('scores', PAGES);
buildPage('authors', PAGES);
buildPage('years', PAGES);
buildPage('systems', PAGES);
buildPage('sitemap', PAGES);

writePagesHtml(PAGES);
writeRedirects(PAGES);

for(const page_name of Object.keys(PAGES)) {
    const page = PAGES[page_name];
    if (page.todo) {
        console.warn(`Cannot publish! '${page.id}' is marked as TODO!`);
    }
}

execSync(`cd build && zip -j ../archive-${VARS.version}.zip *`);