const React = require("react");
const ReactDOM = require("react-dom");
const { chain, identity } = require("lodash");
const { shell } = require("electron");
const { spawn } = require("child_process");
const { useHotkeys } = require("react-hotkeys-hook");

const {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Masonry
} = require("react-virtualized");

const { useState, useEffect, useCallback, useRef } = React;

const SPACER = 10;

const talkToProcess = async (command, args) => {
  return new Promise(resolve => {
    const process = spawn(
      "node",
      args ? ["./process.js", command, args] : ["./process.js", command]
    );

    let data = "";

    process.stdout.on("data", d => {
      data += d.toString();
    });

    process.stderr.on("data", data => {
      console.log("[stderr]", data.toString());
    });

    process.on("exit", () => {
      resolve(JSON.parse(data));
    });
  });
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400) - SPACER;
};

const HoverInfo = ({ meta, link, img }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
    <a
      className="f6 mb2 lh-title no-underline underline-hover white db"
      href="#"
      onClick={() => shell.openExternal(link)}
    >
      {meta.title || link}
    </a>

    {meta.note && <div className="mb2 lh-copy">{meta.note}</div>}

    {meta.tags && (
      <div className="light-gray">{meta.tags.map(t => `#${t}`).join(", ")}</div>
    )}

    <div className="mt2">
      {[
        ["src", () => shell.openExternal(link)],
        meta.static && ["frozen", () => shell.openItem(meta.static)],
        ["img", () => shell.openItem(img)]
      ]
        .filter(identity)
        .map(([text, callback]) => (
          <a
            key={text}
            className="link dim br2 ph2 pv1 dib white bg-mid-gray mr1"
            href="#"
            onClick={callback}
          >
            {text}
          </a>
        ))}
    </div>
  </div>
);

const createCellRenderer = ({
  data,
  width,
  cache,
  setHoveredId,
  hoveredId
}) => ({ index, key, parent, style }) => {
  const columnWidth = calcColumnWidth({ width });
  const datum = data[index];

  if (!datum) {
    return null;
  }

  const ratio = datum.height / datum.width;

  return (
    <CellMeasurer cache={cache.current} index={index} key={key} parent={parent}>
      <div
        style={style}
        className="h-100"
        onMouseEnter={() => {
          setHoveredId(datum.id);
        }}
        onMouseLeave={() => {
          setHoveredId(null);
        }}
      >
        <div
          className="h-100 relative"
          style={{
            height: ratio * columnWidth,
            width: columnWidth,
            backgroundImage: `url("${datum.img}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center"
          }}
        >
          {hoveredId === datum.id && <HoverInfo {...datum} />}
        </div>
      </div>
    </CellMeasurer>
  );
};

const SearchOverlay = ({ searchText, setSearchText, setIsSearching }) => {
  return (
    <div className="absolute">
      <input
        autoFocus={true}
        value={searchText}
        onChange={e => setSearchText(e.target.value)}
        onKeyDown={e => {
          // escape
          if (e.keyCode === 27) {
            setIsSearching(false);
          }
        }}
      />
    </div>
  );
};

const App = () => {
  const [data, setData] = useState([]);
  const [filteredData, setFilteredData] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchText, setSearchText] = useState("");
  const masonry = useRef(null);

  useHotkeys(
    "/",
    () => {
      if (!isSearching) {
        setIsSearching(true);
      }

      return false;
    },
    [isSearching]
  );

  const cache = useRef(
    new CellMeasurerCache({
      defaultHeight: 400,
      defaultWidth: 400,
      fixedWidth: true
    })
  );

  const cellPositioner = useRef(
    createMasonryCellPositioner({
      cellMeasurerCache: cache.current,
      columnCount: 3,
      columnWidth: 400,
      spacer: SPACER
    })
  );

  useEffect(() => {
    talkToProcess("query").then(data => {
      const finalData = chain(data)
        .map(d => ({ ...d, time: new Date(d.time) }))
        .sortBy(d => d.time)
        .reverse()
        .value();

      setData(finalData);
    });
  }, []);

  const onResize = useCallback(
    ({ width }) => {
      const columnWidth = calcColumnWidth({ width });
      const columnCount = Math.floor(Math.max(width / columnWidth, 1));

      if (cache.current) {
        cache.current.clearAll();
      }

      if (cellPositioner.current) {
        cellPositioner.current.reset({
          columnCount,
          columnWidth,
          spacer: SPACER
        });
      }

      if (masonry.current) {
        masonry.current.clearCellPositions();
      }
    },
    [cache, cellPositioner, masonry]
  );

  useEffect(() => {
    if (searchText.length > 0) {
      const lowerSearchText = searchText.toLowerCase();

      setFilteredData(
        data.filter(d => {
          return [d.link, d.meta.title, d.meta.note, ...(d.meta.tags || [])]
            .filter(identity)
            .some(t => t.includes(lowerSearchText));
        })
      );
    } else {
      setFilteredData(data);
    }
  }, [data, searchText]);

  return (
    <div className="sans-serif w-100 vh-100 bg-light-gray">
      <AutoSizer
        key={searchText + "-" + filteredData.length}
        onResize={onResize}
        style={{ outline: "none" }}
      >
        {({ width, height }) =>
          filteredData.length > 0 ? (
            <Masonry
              style={{ padding: SPACER }}
              overscanByPixels={300}
              ref={masonry}
              cellCount={filteredData.length}
              cellMeasurerCache={cache.current}
              cellPositioner={cellPositioner.current}
              cellRenderer={createCellRenderer({
                data: filteredData,
                width,
                cache,
                setHoveredId,
                hoveredId
              })}
              width={width}
              height={height}
            />
          ) : (
            <div />
          )
        }
      </AutoSizer>

      {isSearching && (
        <SearchOverlay
          setIsSearching={setIsSearching}
          searchText={searchText}
          setSearchText={setSearchText}
        />
      )}
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("app"));
