const fs = require('fs').promises
const path = require('path')
const url = require('url')
const Feed = require('feed').Feed
const dayjs = require('dayjs')

const urlWithBase = (path, base, enforceTrailingSlashes) => {
  if (enforceTrailingSlashes && !path.endsWith('/') && !/\.[a-z]{1,4}$/i.test(path)) {
    path = path + '/'
  }
  return new url.URL(path, base).href
}

const convertToSiteUrls = (html, baseUrl, enforceTrailingSlashes) => {
  // Currently playing it conservative and only modifying things that are explicitly relative URLs
  const relativeRefs = /(href|src)=("|')((?=\.{1,2}\/|\/).+?)\2/gi
  return html.replace(relativeRefs, (_, attribute, quote, relUrl) => {
    return [attribute, '=', quote, urlWithBase(relUrl, baseUrl, enforceTrailingSlashes), quote].join('')
  })
}

const ensureExtension = (path, extension) => {
  if (path.endsWith(extension)) return path
  if (path.endsWith('/')) {
    return `${path.substring(0, path.length - 1)}${extension}`
  }
  return `${path}${extension}`
}

const writeFile = (outputDir, outputFile, content) => {
  fs.mkdir(outputDir, { recursive: true })
    .then(() => Promise.all([
      fs.writeFile(path.join(outputDir, outputFile), content),
    ]))
    .catch(() => {
      throw new Error(`Couldn't generate the output feed`)
    })
}

const defaultFeedOptions = {
  name: 'feed',
  contentTypes: [],
  feedOptions: {},
  rss: {
    enabled: true,
    output: '/[name].xml',
  },
  atom: {
    enabled: false,
    output: '/[name].atom',
  },
  json: {
    enabled: false,
    output: '/[name].json',
  },
  maxItems: 25,
  htmlFields: ['description', 'content'],
  enforceTrailingSlashes: false,
  filterNodes: (node) => true,
  nodeToFeedItem: (node) => ({
    title: node.title,
    date: node.date || node.fields.date,
    content: node.content,
  }),
}


const generateFeed = (api, options, config) => {
  if (!options.contentTypes || !options.contentTypes.length) {
    throw new Error(
      'Missing required field `options.contentTypes` for `@microflash/gridsome-plugin-feed` plugin in gridsome.config.js'
    )
  }

  options = {
    ...defaultFeedOptions,
    ...options,
  }
  options = {
    ...options,
    rss: {
      enabled: options.rss.enabled,
      output: options.rss.output.replace('[name]', options.name),
    },
    atom: {
      enabled: options.atom.enabled,
      output: options.atom.output.replace('[name]', options.name),
    },
    json: {
      enabled: options.json.enabled,
      output: options.json.output.replace('[name]', options.name),
    },
  }

  const store = api._app.store
  const pathPrefix = config.pathPrefix !== '/' ? config.pathPrefix : ''
  const siteUrl = config.siteUrl
  const siteHref = urlWithBase(
    pathPrefix,
    siteUrl,
    options.enforceTrailingSlashes
  )
  const feedOptions = {
    generator: 'Gridsome Feed Plugin',
    id: siteHref,
    link: siteHref,
    title: config.siteName,
    ...options.feedOptions,
    feedLinks: {},
  }
  const rssOutput = options.rss.enabled
    ? ensureExtension(options.rss.output, '.xml')
    : null
  const atomOutput = options.atom.enabled
    ? ensureExtension(options.atom.output, '.atom')
    : null
  const jsonOutput = options.json.enabled
    ? ensureExtension(options.json.output, '.json')
    : null

  if (rssOutput) {
    feedOptions.feedLinks.rss = urlWithBase(pathPrefix + rssOutput, siteUrl)
  }

  if (atomOutput) {
    feedOptions.feedLinks.atom = urlWithBase(pathPrefix + atomOutput, siteUrl)
  }

  if (jsonOutput) {
    feedOptions.feedLinks.json = urlWithBase(pathPrefix + jsonOutput, siteUrl)
  }

  const feed = new Feed(feedOptions)

  let feedItems = []

  for (const contentType of options.contentTypes) {
    const { collection } = store.getCollection(contentType)
    if (!collection.data || !collection.data.length) continue
    // We're mapping to feed items here instead of after sorting in case the data needs
    // to be massaged into the proper format for a feed item (e.g. if the node has a date
    // in a field named something other than `date`). This is slower because we process
    // items that may not get included in the feed, but it's build time, so... ¯\_(ツ)_/¯
    const items = collection.data.filter(options.filterNodes).map((node) => {
      const feedItem = options.nodeToFeedItem(node, store)
      feedItem.link =
        feedItem.link ||
        urlWithBase(
          pathPrefix + node.path,
          siteUrl,
          options.enforceTrailingSlashes
        )
      feedItem.id = feedItem.link
      return feedItem
    })

    feedItems.push(...items)
  }

  feedItems.sort((a, b) => {
    const aDate = dayjs(a.date)
    const bDate = dayjs(b.date)
    if (aDate.isSame(bDate)) return 0
    return aDate.isBefore(bDate) ? 1 : -1
  })

  if (options.maxItems && feedItems.length > options.maxItems) {
    feedItems = feedItems.slice(0, options.maxItems)
  }

  // Process URLs and ensure they are site-relative for any fields that might contain HTML
  for (const item of feedItems) {
    if (options.htmlFields && options.htmlFields.length) {
      for (const field of options.htmlFields) {
        if (!item[field]) continue
        item[field] = convertToSiteUrls(
          item[field],
          item.link,
          options.enforceTrailingSlashes
        )
      }
    }
    feed.addItem(item)
  }

  if (rssOutput) {
    console.log(`Generate RSS feed at ${rssOutput}`)
    writeFile(config.outputDir, rssOutput, feed.rss2())
  }

  if (atomOutput) {
    console.log(`Generate Atom feed at ${atomOutput}`)
    writeFile(config.outputDir, atomOutput, feed.atom1())
  }

  if (jsonOutput) {
    console.log(`Generate JSON feed at ${jsonOutput}`)
    writeFile(config.outputDir, jsonOutput, feed.json1())
  }
}

module.exports = (api, options) => {
  api.afterBuild(({ config }) => {
    if (!config.siteUrl) {
      throw new Error('Missing required field `siteUrl` in gridsome.config.js')
    }

    const uniqueFeeds = [...new Set(options.feeds.map(({ name }) => name))]
    if (options.feeds.length != uniqueFeeds.length) {
      throw new Error('Each feed has to have a unique name')
    }
    if (options.feeds)
      options.feeds.forEach((feedOptions) => {
        generateFeed(api, feedOptions, config)
      })
  })
}

module.exports.defaultOptions = () => ({
  feeds: [],
})
