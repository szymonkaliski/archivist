import { Command, open } from "@tauri-apps/api/shell";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { writeText } from "@tauri-apps/api/clipboard";
import dateFormat from "dateformat";

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useReducer,
} from "react";
import ReactDOM from "react-dom/client";
import strip from "strip";
import { chain, identity } from "lodash";
import { produce } from "immer";
import { useThrottle } from "use-throttle";
import { useHotkeys } from "react-hotkeys-hook";

import {
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Grid,
  Masonry,
} from "react-virtualized";

require("tachyons/src/tachyons.css");
require("react-virtualized/styles.css");

const SPACER = 10;
const THROTTLE_TIME = 100;

const USE_MASONRY = false;
const USE_GRID = true;

const HAS_ARCHIVIST = true;

const executeCLI = async (command, args) => {
  return new Promise((resolve) => {
    const cmdArgs = [
      "-c",
      ["archivist", command, ...args, "--json"].filter(identity).join(" "),
    ];

    console.time("shell");
    new Command("shell", cmdArgs).execute().then((cmd) => {
      console.timeEnd("shell");
      resolve(JSON.parse(cmd.stdout));
    });
  });
};

const shorten = (text, length) => {
  if (text.length < length) {
    return text;
  }

  return text.slice(0, length - 1).trim() + "…";
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400);
};

const Info = ({ meta, link, img, time, setSearchText }) => {
  return (
    <div>
      <a
        className="mb2 db f6 lh-title no-underline underline-hover white word-wrap truncate"
        href="#"
        onClick={() => link && open(link)}
      >
        {meta.title || link}
      </a>

      {meta.note && (
        <div className="mb2 lh-copy">{shorten(strip(meta.note), 300)}</div>
      )}

      {meta.tags && (
        <div>
          {meta.tags.map((tag) => (
            <a
              key={tag}
              className="no-underline underline-hover light-gray mr1"
              href="#"
              onClick={() => setSearchText(tag)}
            >
              {tag}
            </a>
          ))}
        </div>
      )}

      <div className="mt2 flex justify-between items-center">
        <div>
          {[
            link && ["src", () => open(link)],
            meta.static && ["frozen", () => open(meta.static)],
            ["img", () => open(img)],
            ["copy img path", () => writeText(`'${img}'`)],
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
        <div className="tr gray">
          {meta.source} / {dateFormat(time, "yyyy-mm-dd")}
        </div>
      </div>
    </div>
  );
};

const HoverInfo = ({ ...props }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white w-100"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
    <Info {...props} />
  </div>
);

const createMasonryCellRenderer =
  ({ data, width, cache, setHoveredId, hoveredId, setSearchText }) =>
  ({ index, key, parent, style }) => {
    const columnWidth = calcColumnWidth({ width }) - SPACER;
    const datum = data[index] || {};
    const ratio = datum.height / datum.width;

    return (
      <CellMeasurer
        cache={cache.current}
        index={index}
        key={key}
        parent={parent}
      >
        <div
          style={style}
          className="h-100"
          onMouseEnter={() => setHoveredId(datum.id)}
          onMouseLeave={() => setHoveredId(null)}
        >
          <div
            className="h-100 relative"
            style={{
              height: ratio * columnWidth,
              width: columnWidth,
              backgroundImage: `url("file://${datum.img}")`,
              backgroundSize: "contain",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center",
              transform: "translateZ(0)",
            }}
          >
            {hoveredId === datum.id && (
              <HoverInfo setSearchText={setSearchText} {...datum} />
            )}
          </div>
        </div>
      </CellMeasurer>
    );
  };

const SearchOverlay = React.forwardRef(
  ({ searchText, setSearchText, setIsSearching }, ref) => (
    <div
      className="absolute flex pa2 bg-dark-gray white f7 code"
      style={{ left: 0, right: 0, bottom: 0 }}
    >
      <div className="mr2 lh-copy gray">/</div>
      <input
        ref={ref}
        className="w-100 bg-dark-gray white outline-0 bw0 lh-copy"
        autoFocus={true}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => {
          // escape
          if (e.keyCode === 27) {
            setIsSearching(false);
          }
        }}
      />
    </div>
  )
);

const createGridCellRenderer =
  ({ data, setHoveredId, hoveredId, setSearchText, columnCount }) =>
  ({ columnIndex, rowIndex, key, style }) => {
    const index = rowIndex * columnCount + columnIndex;
    const datum = data[index];

    if (!datum) {
      return null;
    }

    return (
      <div
        key={key}
        style={{ ...style, padding: 1 }}
        className="h-100"
        onMouseEnter={() => setHoveredId(datum.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        <div
          className="h-100 relative bg-light-gray"
          style={{
            backgroundImage: `url(${convertFileSrc(datum.img)})`,
            backgroundSize: "contain",
            // backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            transform: "translateZ(0)",
          }}
        >
          {hoveredId === datum.id && (
            <HoverInfo setSearchText={setSearchText} {...datum} />
          )}
        </div>
      </div>
    );
  };

const GridWrapper = ({
  data,
  width,
  height,
  setHoveredId,
  hoveredId,
  setSearchText,
}) => {
  const columnWidth = calcColumnWidth({ width });
  const columnCount = Math.round(width / columnWidth);
  const rowCount = Math.ceil(data.length / columnCount);

  return (
    <Grid
      cellRenderer={createGridCellRenderer({
        data,
        setHoveredId,
        hoveredId,
        setSearchText,
        columnCount,
      })}
      height={height}
      width={width}
      columnCount={columnCount}
      columnWidth={columnWidth}
      rowCount={rowCount}
      rowHeight={columnWidth}
    />
  );
};

const reducer = (state, action) => {
  if (action.type === "SET_DATA") {
    state.data = action.data;
  }

  if (action.type === "SET_IS_SEARCHING") {
    state.isSearching = action.isSearching;
    state.searchText = "";
  }

  if (action.type === "SET_SEARCH_TEXT") {
    state.isSearching = true;
    state.searchText = action.searchText;
  }

  if (action.type === "SET_HOVER_ID") {
    state.hoverId = action.hoverId;
  }

  if (action.type === "SET_HAS_BOOTED") {
    state.isBooting = false;
  }

  return state;
};

const immutableReducer = produce(reducer);

const App = () => {
  const [state, dispatch] = useReducer(immutableReducer, {
    data: [],
    searchText: "",
    isBooting: true,
    isSearching: false,
    hoverId: null,
  });
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const ref = useRef(null);

  const lastEntry = useRef("");
  const throttledSearchText = useThrottle(state.searchText, THROTTLE_TIME);

  const searchInputRef = useRef(null);
  const masonry = useRef(null);

  useHotkeys(
    "/",
    () => {
      if (!state.isSearching) {
        // otherwise `/` ends up in text input
        setTimeout(() => {
          dispatch({ type: "SET_IS_SEARCHING", isSearching: true });
        }, 0);
      } else if (searchInputRef.current) {
        searchInputRef.current.focus();
      }

      return false;
    },
    [state.isSearching]
  );

  useHotkeys(
    "esc",
    () => {
      if (state.isSearching) {
        dispatch({ type: "SET_IS_SEARCHING", isSearching: false });
      }

      return false;
    },
    [state.isSearching]
  );

  const cache = useRef(
    new CellMeasurerCache({
      defaultHeight: 400,
      defaultWidth: 400,
      fixedWidth: true,
    })
  );

  const cellPositioner = useRef(
    createMasonryCellPositioner({
      cellMeasurerCache: cache.current,
      columnCount: 3,
      columnWidth: 400,
      spacer: SPACER,
    })
  );

  const isBooting = state.isBooting;

  useEffect(() => {
    lastEntry.current = throttledSearchText;

    console.time("execute");

    executeCLI(
      "search",
      throttledSearchText && throttledSearchText.length >= 1
        ? [`"${throttledSearchText}"`]
        : isBooting // start by querying just a couple of items for faster perceived start
        ? ["--limit", "10"]
        : []
    )
      .then((data) => {
        if (lastEntry.current !== throttledSearchText) {
          return;
        }

        const finalData = chain(data)
          .map((d) => Object.assign(d, { time: new Date(d.time) }))
          .sortBy((d) => d.time)
          .reverse()
          .value();

        console.timeEnd("execute");

        dispatch({ type: "SET_DATA", data: finalData });
        dispatch({ type: "SET_HAS_BOOTED" });
      })
      .catch((e) => {
        console.error("archivist-cli error", e.toString());
      });
  }, [throttledSearchText, isBooting]);

  useEffect(() => {
    function onResize() {
      const rect = ref.current.getBoundingClientRect();
      const { width, height } = rect;

      const columnWidth = calcColumnWidth({ width });
      const columnCount = Math.floor(Math.max(width / columnWidth, 1));

      if (cache.current) {
        cache.current.clearAll();
      }

      if (cellPositioner.current) {
        cellPositioner.current.reset({
          columnCount,
          columnWidth,
          spacer: SPACER,
        });
      }

      if (masonry.current) {
        masonry.current.clearCellPositions();
      }

      setSize({ width, height });
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("load", onResize);
    onResize();

    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [ref, cache, cellPositioner, masonry]);

  if (!HAS_ARCHIVIST) {
    return (
      <div className="sans-serif w-100 vh-100 bg-light-gray code red pa4 f6">
        Error: archivist cli tool not found
      </div>
    );
  }

  const canRender = state.data.length > 0 && width > 0 && height > 0;

  return (
    <div
      className="sans-serif w-100 vh-100 bg-white"
      style={{ padding: 1 }}
      ref={ref}
    >
      {canRender && (
        <>
          {USE_MASONRY && (
            <Masonry
              style={{ padding: SPACER / 2 }}
              overscanByPixels={300}
              ref={masonry}
              cellCount={state.data.length}
              cellMeasurerCache={cache.current}
              cellPositioner={cellPositioner.current}
              cellRenderer={createMasonryCellRenderer({
                data: state.data,
                width,
                cache,
                setHoveredId: (hoverId) =>
                  dispatch({ type: "SET_HOVER_ID", hoverId }),
                hoveredId: state.hoverId,
                setSearchText: (searchText) => {
                  dispatch({ type: "SET_SEARCH_TEXT", searchText });
                },
              })}
              width={width}
              height={height}
            />
          )}

          {USE_GRID && (
            <GridWrapper
              data={state.data}
              height={height}
              width={width}
              setHoveredId={(hoverId) =>
                dispatch({ type: "SET_HOVER_ID", hoverId })
              }
              hoveredId={state.hoverId}
              setSearchText={(searchText) => {
                dispatch({ type: "SET_SEARCH_TEXT", searchText });
              }}
            />
          )}
        </>
      )}

      {state.isSearching && (
        <SearchOverlay
          ref={searchInputRef}
          searchText={state.searchText}
          setIsSearching={(isSearching) =>
            dispatch({ type: "SET_IS_SEARCHING", isSearching })
          }
          setSearchText={(searchText) =>
            dispatch({ type: "SET_SEARCH_TEXT", searchText })
          }
        />
      )}
    </div>
  );
};

const rootEl = document.getElementById("app");
const root = ReactDOM.createRoot(rootEl);
root.render(<App />);
