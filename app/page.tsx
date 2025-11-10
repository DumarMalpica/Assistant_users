"use client";

import React from "react";
import styles from "./page.module.css";

const Home = () => {
  const categories = {
    "Chat básico": "basic-chat",
    "Búsqueda e ingesta de archivos": "file-search",
  };

  return (
    <main className={styles.main}>
      <div className={styles.title}>
        Explora aplicaciones de ejemplo creadas con la API de Assistants
      </div>
      <div className={styles.container}>
        {Object.entries(categories).map(([name, url]) => (
          <a key={name} className={styles.category} href={`/examples/${url}`}>
            {name}
          </a>
        ))}
      </div>
    </main>
  );
};

export default Home;
