const express = require('express');
const cors = require('cors');
const db = require('./db'); 
const multer = require('multer'); 
const fs = require('fs'); 
const cloudinary = require('cloudinary').v2; 
const path = require('path'); 

const app = express();
const PORT = process.env.PORT || 5000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_UPLOAD_DIR); 
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage }); 

const TEMP_BASE_DIR = '/tmp';
const TEMP_UPLOAD_DIR = path.join(TEMP_BASE_DIR, 'temp_uploads');

if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
}


function getPublicIdFromUrl(url) {
    if (!url) return null;
    const parts = url.split('/');
    const filename = parts.pop();
    const publicId = filename.substring(0, filename.lastIndexOf('.'));
    return publicId;
}


function deleteTempFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) console.error("Gagal menghapus file sementara:", err);
        });
    }
}


// --- Middleware ---
app.use(cors()); 
app.use(express.json()); 


app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // UPDATE: Pilih fullname
        const result = await db.query('SELECT id, username, fullname FROM admin_users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: "username atau kata sandi salah" });
        }
        // UPDATE: Kembalikan info user termasuk fullname
        res.json({ message: "Login berhasil", user: result.rows[0] });
    } catch (err) {
        console.error("Error during login:", err);
        res.status(500).json({ message: "Terjadi kesalahan server saat login." });
    }
});


// --- Endpoint API untuk Buku ---

// 1. GET /api/books (Read All)
app.get('/api/books', async (req, res) => {
  try {
    // UPDATE: Pilih added_by_admin
    const result = await db.query('SELECT *, added_by_admin FROM books ORDER BY id DESC'); 
    res.json(result.rows); 
  } catch (err) {
    console.error("Error fetching books:", err);
    res.status(500).json({ message: "Gagal mengambil data buku dari database." });
  }
});


// 2. POST /api/books (Create)
app.post('/api/books', upload.single('cover_file'), async (req, res) => {
  // UPDATE: Tambahkan added_by_admin
  const { title, author, publisher, year, category, stock, description, status, borrowers_json, added_by_admin } = req.body;
  const tempFilePath = req.file ? req.file.path : null; 
  
  const yearInt = year ? parseInt(year) : null;
  const stockInt = stock ? parseInt(stock) : 0;
  const borrowers = JSON.parse(borrowers_json || '[]'); 
  
  let coverUrl = null;

  try {
    // 1. Upload ke Cloudinary jika ada file
    if (tempFilePath) {
        const cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
            folder: "smart-library-covers",
        });
        coverUrl = cloudinaryResult.secure_url;
    }
    
    // 2. Simpan URL Cloudinary & added_by_admin ke Database
    const INSERT_QUERY = `
      INSERT INTO books 
      (title, author, publisher, year, category, cover, stock, description, status, borrowers, added_by_admin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
      RETURNING *;
    `;
    // UPDATE: Tambahkan added_by_admin ke values
    const values = [
      title, author, publisher, yearInt, category, coverUrl, 
      stockInt, description, status, JSON.stringify(borrowers), added_by_admin
    ];
    
    const result = await db.query(INSERT_QUERY, values);
    
    res.status(201).json(result.rows[0]); 
  } catch (err) {
    console.error("Error creating book:", err);
    res.status(500).json({ message: "Gagal menambahkan buku." });
  } finally {
    // 3. Hapus file sementara lokal
    deleteTempFile(tempFilePath); 
  }
});


// 3. PUT /api/books/:id (Update)
app.put('/api/books/:id', upload.single('cover_file'), async (req, res) => {
  const { id } = req.params;
  const { 
    title, author, publisher, year, category, 
    stock, description, status, borrowers_json, existing_cover, added_by_admin 
  } = req.body; // UPDATE: Tambahkan added_by_admin
  const yearInt = year ? parseInt(year) : null;
  const stockInt = stock ? parseInt(stock) : 0;
  const borrowers = JSON.parse(borrowers_json || '[]');
  const tempFilePath = req.file ? req.file.path : null; 

  let newCoverUrl = null;
  let oldCoverUrl = null;
  
  // 1. Dapatkan URL lama dari DB
  const existingBook = await db.query('SELECT cover FROM books WHERE id = $1', [id]);
  if (existingBook.rows.length > 0) {
      oldCoverUrl = existingBook.rows[0].cover;
  }
  
  try {
    if (tempFilePath) {
        // Case 1: Ada file baru diupload. Upload file baru
        const cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
            folder: "smart-library-covers",
        });
        newCoverUrl = cloudinaryResult.secure_url;
        
        // Hapus cover lama dari Cloudinary jika ada
        if (oldCoverUrl) {
            const publicId = path.basename(oldCoverUrl, path.extname(oldCoverUrl));
            await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`); 
        }

    } else if (existing_cover) {
        // Case 2: Tidak ada file baru, tapi ada URL lama (tidak diubah)
        newCoverUrl = oldCoverUrl; 
    } else {
        // Case 3: Gambar dihapus (atau memang tidak ada)
        newCoverUrl = null;
        // Hapus cover lama dari Cloudinary jika ada
        if (oldCoverUrl) {
            const publicId = path.basename(oldCoverUrl, path.extname(oldCoverUrl));
            await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`);
        }
    }


    // 2. Update Database
    const UPDATE_QUERY = `
      UPDATE books SET
        title = $1, author = $2, publisher = $3, year = $4, category = $5, 
        cover = $6, stock = $7, description = $8, status = $9, borrowers = $10, added_by_admin = $11
      WHERE id = $12
      RETURNING *;
    `;
    // UPDATE: Tambahkan added_by_admin ke values
    const values = [
      title, author, publisher, yearInt, category, 
      newCoverUrl, stockInt, description, status, JSON.stringify(borrowers), added_by_admin, id 
    ];

    const result = await db.query(UPDATE_QUERY, values);

    if (result.rows.length === 0) {
        return res.status(404).json({ message: `Buku dengan ID ${id} tidak ditemukan.` });
    }
    
    res.json(result.rows[0]); 
  } catch (err) {
    console.error("Error updating book:", err);
    res.status(500).json({ message: "Gagal memperbarui buku." });
  } finally {
    // 3. Hapus file sementara lokal
    deleteTempFile(tempFilePath); 
  }
});

// 4. DELETE /api/books/:id (Delete)
app.delete('/api/books/:id', async (req, res) => {
  const { id } = req.params;

  let coverUrlToDelete = null;
  
  try {
    // 1. Ambil URL cover lama sebelum dihapus
    const existingBook = await db.query('SELECT cover FROM books WHERE id = $1', [id]);
    if (existingBook.rows.length > 0) {
        coverUrlToDelete = existingBook.rows[0].cover;
    }

    // 2. Hapus dari Database
    const DELETE_QUERY = 'DELETE FROM books WHERE id = $1 RETURNING *;';
    const result = await db.query(DELETE_QUERY, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: `Buku dengan ID ${id} tidak ditemukan.` });
    }

    // 3. Hapus dari Cloudinary
    if (coverUrlToDelete) {
        const publicId = path.basename(coverUrlToDelete, path.extname(coverUrlToDelete));
        await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`); 
        console.log(`File cover dihapus dari Cloudinary: ${publicId}`);
    }

    res.status(204).send(); 
  } catch (err) {
    console.error("Error deleting book:", err);
    res.status(500).json({ message: "Gagal menghapus buku." });
  }
});

app.get('/', (req, res) => {
    res.send('Smart Library API sedang berjalan...');
});

const startServer = async () => {
    try {
        await db.initializeDatabase();
        
        app.listen(PORT, () => {
          console.log(`Server berjalan di port ${PORT}`);
        });
    } catch (error) {
        console.error("Gagal memulai server:", error);
        process.exit(1);
    }
}

startServer();
